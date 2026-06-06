/**
 * GitHub tool executors for the AI assistant — READ-ONLY (issues + pull requests).
 *
 * Each function:
 * - Resolves the org's sealed GitHub PAT via getOrgCredential(orgId, 'github')
 *   (org-SHARED, not per-user — the integration is installed for the whole org).
 *   On a missing credential, returns a graceful `{ error }` (mirrors the Google
 *   "not connected" pattern) so the model can apologise and continue.
 * - Resolves owner/repo from the args, falling back to the integration's configured
 *   `defaultOwner`/`defaultRepo` (Integration.config, plaintext — non-secret).
 * - Calls the GitHub REST API via `fetch` (no new heavy dep). The fetch is
 *   INJECTABLE via the optional ctx.fetchImpl so tests mock it without a network.
 * - Returns a SHALLOW shape including title/body/labels — the egress chokepoint
 *   (src/lib/ai/egress) decides what the MODEL actually sees (gov: structural-only,
 *   number/state/timestamps; title/body withheld). The executor NEVER returns the
 *   token, and we never log it.
 */

import { prisma } from "@/lib/db/client";
import { getOrgCredential } from "@/lib/integrations/credentials";

/** Minimal fetch signature we depend on — lets tests inject a mock. */
type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

interface GitHubToolContext {
  userId: string;
  /** The caller's org — scopes the sealed org credential + the integration config. */
  orgId: string;
  /** Injected fetch for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

type ToolArgs = Record<string, unknown>;

const API_BASE = "https://api.github.com";
const NOT_CONNECTED =
  "GitHub is not connected for this organization. Ask an admin to install the GitHub integration (paste a fine-grained read-only Personal Access Token) on the Integrations page.";

/** Resolve the org's sealed PAT + configured owner/repo defaults, or a graceful error. */
async function resolveGitHubAccess(
  ctx: GitHubToolContext,
): Promise<
  | { error: string }
  | { token: string; defaultOwner?: string; defaultRepo?: string }
> {
  const bundle = await getOrgCredential(ctx.orgId, "github");
  if (!bundle || !bundle.token) {
    return { error: NOT_CONNECTED };
  }
  // Non-secret config (defaultOwner/defaultRepo) lives in Integration.config.
  const integration = await prisma.integration.findFirst({
    where: { orgId: ctx.orgId, provider: "github" },
    select: { config: true },
  });
  const config = (integration?.config ?? {}) as Record<string, unknown>;
  const defaultOwner =
    typeof config.defaultOwner === "string" ? config.defaultOwner : undefined;
  const defaultRepo =
    typeof config.defaultRepo === "string" ? config.defaultRepo : undefined;
  return { token: bundle.token, defaultOwner, defaultRepo };
}

/** Resolve owner/repo from args with the integration defaults, or an error if neither. */
function resolveRepo(
  args: ToolArgs,
  defaults: { defaultOwner?: string; defaultRepo?: string },
): { owner: string; repo: string } | { error: string } {
  const owner =
    (typeof args.owner === "string" && args.owner) || defaults.defaultOwner;
  const repo =
    (typeof args.repo === "string" && args.repo) || defaults.defaultRepo;
  if (!owner || !repo) {
    return {
      error:
        "owner and repo are required (none provided and the GitHub integration has no defaultOwner/defaultRepo configured).",
    };
  }
  return { owner, repo };
}

/** Issue a GET against the GitHub REST API with the sealed token. */
async function githubGet(
  ctx: GitHubToolContext,
  token: string,
  path: string,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const doFetch = ctx.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const res = await doFetch(`${API_BASE}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "cosmos-connector",
    },
  });
  if (!res.ok) {
    // Surface a clean, token-free error. 401/403 → likely a bad/expired PAT.
    let detail = "";
    try {
      const body = (await res.json()) as { message?: unknown };
      if (body && typeof body.message === "string") detail = `: ${body.message}`;
    } catch {
      /* body not JSON — ignore */
    }
    return { ok: false, error: `GitHub API error (HTTP ${res.status})${detail}` };
  }
  return { ok: true, data: await res.json() };
}

function clampLimit(raw: unknown): number {
  return Math.min(Math.max(Number(raw ?? 20) || 20, 1), 50);
}

function normState(raw: unknown): "open" | "closed" | "all" {
  return raw === "closed" || raw === "all" ? raw : "open";
}

/** A GitHub issue/PR label may be a string or an object — normalize to its name. */
function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((l) =>
      typeof l === "string"
        ? l
        : l && typeof l === "object" && typeof (l as { name?: unknown }).name === "string"
          ? (l as { name: string }).name
          : undefined,
    )
    .filter((n): n is string => Boolean(n));
}

async function safeRun<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
}

// ── Tools ──────────────────────────────────────────────────────────────────

export async function githubListIssues(args: ToolArgs, ctx: GitHubToolContext) {
  return safeRun(async () => {
    const access = await resolveGitHubAccess(ctx);
    if ("error" in access) return access;
    const target = resolveRepo(args, access);
    if ("error" in target) return target;

    const state = normState(args.state);
    const limit = clampLimit(args.limit);
    const res = await githubGet(
      ctx,
      access.token,
      `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues?state=${state}&per_page=${limit}`,
    );
    if (!res.ok) return { error: res.error };

    const raw = Array.isArray(res.data) ? res.data : [];
    // The /issues endpoint also returns PRs (they carry a `pull_request` key) —
    // drop them so this tool is issues-only.
    const issues = raw
      .filter((i) => i && typeof i === "object" && !("pull_request" in i))
      .map((i) => {
        const o = i as Record<string, unknown>;
        return {
          number: o.number,
          state: o.state,
          title: o.title,
          labels: labelNames(o.labels),
          createdAt: o.created_at,
          updatedAt: o.updated_at,
          closedAt: o.closed_at,
        };
      });

    return { success: true, count: issues.length, issues };
  });
}

export async function githubGetIssue(args: ToolArgs, ctx: GitHubToolContext) {
  return safeRun(async () => {
    const number = Number(args.number);
    if (!Number.isFinite(number) || number <= 0) {
      return { error: "number (a positive issue number) is required" };
    }
    const access = await resolveGitHubAccess(ctx);
    if ("error" in access) return access;
    const target = resolveRepo(args, access);
    if ("error" in target) return target;

    const res = await githubGet(
      ctx,
      access.token,
      `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${number}`,
    );
    if (!res.ok) return { error: res.error };

    const o = (res.data ?? {}) as Record<string, unknown>;
    return {
      success: true,
      issue: {
        number: o.number,
        state: o.state,
        title: o.title,
        body: typeof o.body === "string" ? o.body : "",
        labels: labelNames(o.labels),
        createdAt: o.created_at,
        updatedAt: o.updated_at,
        closedAt: o.closed_at,
      },
    };
  });
}

export async function githubListPullRequests(
  args: ToolArgs,
  ctx: GitHubToolContext,
) {
  return safeRun(async () => {
    const access = await resolveGitHubAccess(ctx);
    if ("error" in access) return access;
    const target = resolveRepo(args, access);
    if ("error" in target) return target;

    const state = normState(args.state);
    const limit = clampLimit(args.limit);
    const res = await githubGet(
      ctx,
      access.token,
      `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls?state=${state}&per_page=${limit}`,
    );
    if (!res.ok) return { error: res.error };

    const raw = Array.isArray(res.data) ? res.data : [];
    const pulls = raw
      .filter((p) => p && typeof p === "object")
      .map((p) => {
        const o = p as Record<string, unknown>;
        return {
          number: o.number,
          state: o.state,
          title: o.title,
          draft: o.draft,
          createdAt: o.created_at,
          updatedAt: o.updated_at,
          closedAt: o.closed_at,
          mergedAt: o.merged_at,
        };
      });

    return { success: true, count: pulls.length, pullRequests: pulls };
  });
}

// ── Dispatch ─────────────────────────────────────────────────────────────

/**
 * Map of GitHub tool name → executor. Returns `null` if the name is not a GitHub
 * tool, so the parent dispatcher falls through to other tool families.
 */
export async function executeGitHubTool(
  name: string,
  args: ToolArgs,
  ctx: GitHubToolContext,
): Promise<unknown | null> {
  switch (name) {
    case "github_list_issues":
      return githubListIssues(args, ctx);
    case "github_get_issue":
      return githubGetIssue(args, ctx);
    case "github_list_pull_requests":
      return githubListPullRequests(args, ctx);
    default:
      return null;
  }
}

/** Names of all GitHub tools — for O(1) membership in the central dispatcher. */
export const GITHUB_TOOL_NAMES: ReadonlySet<string> = new Set([
  "github_list_issues",
  "github_get_issue",
  "github_list_pull_requests",
]);
