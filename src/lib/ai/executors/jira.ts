/**
 * Jira (Cloud) tool executors for the AI assistant — READ-focused + one safe write.
 *
 * Each function:
 * - Resolves the org's sealed Jira credential via getOrgCredential(orgId, 'jira')
 *   (org-SHARED, not per-user — the integration is installed for the whole org). The
 *   sealed bundle is `{ email, apiToken }`. On a missing/incomplete credential, returns
 *   a graceful `{ error }` (mirrors the GitHub "not connected" pattern) so the model
 *   can apologise and continue.
 * - Resolves the site `baseUrl` + optional `defaultProjectKey` from the integration's
 *   non-secret config (Integration.config, plaintext).
 * - Calls the Jira Cloud REST v3 API via `fetch` with HTTP Basic auth
 *   (`Authorization: Basic base64(email:apiToken)`). The fetch is INJECTABLE via the
 *   optional ctx.fetchImpl so tests mock it without a network.
 * - Returns a SHALLOW shape including summary/description — the egress chokepoint
 *   (src/lib/ai/egress) decides what the MODEL actually sees (gov: structural-only,
 *   key/status/priority/issueType/timestamps; summary/description/comments withheld).
 *   The executor NEVER returns the token, and we never log it.
 */

import { prisma } from "@/lib/db/client";
import { getOrgCredential } from "@/lib/integrations/credentials";

/** Minimal fetch signature we depend on — lets tests inject a mock. */
type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

interface JiraToolContext {
  userId: string;
  /** The caller's org — scopes the sealed org credential + the integration config. */
  orgId: string;
  /** Injected fetch for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

type ToolArgs = Record<string, unknown>;

const NOT_CONNECTED =
  "Jira is not connected for this organization. Ask an admin to install the Jira integration (Atlassian email + API token + site base URL) on the Integrations page.";

interface JiraAccess {
  email: string;
  apiToken: string;
  baseUrl: string;
  defaultProjectKey?: string;
}

/** Resolve the org's sealed Jira credential + non-secret config, or a graceful error. */
async function resolveJiraAccess(
  ctx: JiraToolContext,
): Promise<{ error: string } | JiraAccess> {
  const bundle = await getOrgCredential(ctx.orgId, "jira");
  if (!bundle || !bundle.email || !bundle.apiToken) {
    return { error: NOT_CONNECTED };
  }
  // Non-secret config (baseUrl/defaultProjectKey) lives in Integration.config.
  const integration = await prisma.integration.findFirst({
    where: { orgId: ctx.orgId, provider: "jira" },
    select: { config: true },
  });
  const config = (integration?.config ?? {}) as Record<string, unknown>;
  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : undefined;
  if (!baseUrl) {
    return {
      error:
        "Jira is connected but no site base URL is configured (e.g. https://acme.atlassian.net). Ask an admin to set it on the Integrations page.",
    };
  }
  const defaultProjectKey =
    typeof config.defaultProjectKey === "string"
      ? config.defaultProjectKey
      : undefined;
  return {
    email: bundle.email,
    apiToken: bundle.apiToken,
    baseUrl: baseUrl.replace(/\/+$/, ""), // strip trailing slashes
    defaultProjectKey,
  };
}

/** Build the HTTP Basic auth header from the sealed email + API token. */
function basicAuth(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
}

/** Issue a request against the Jira Cloud REST API with the sealed Basic credential. */
async function jiraFetch(
  ctx: JiraToolContext,
  access: JiraAccess,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const doFetch = ctx.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const res = await doFetch(`${access.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: basicAuth(access.email, access.apiToken),
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      "User-Agent": "cosmos-connector",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    // Surface a clean, token-free error. 401/403 → likely bad/expired credentials.
    let detail = "";
    try {
      const parsed = (await res.json()) as {
        errorMessages?: unknown;
        errors?: unknown;
      };
      if (Array.isArray(parsed?.errorMessages) && parsed.errorMessages.length) {
        detail = `: ${parsed.errorMessages.join("; ")}`;
      } else if (parsed?.errors && typeof parsed.errors === "object") {
        const vals = Object.values(parsed.errors as Record<string, unknown>)
          .filter((v): v is string => typeof v === "string")
          .join("; ");
        if (vals) detail = `: ${vals}`;
      }
    } catch {
      /* body not JSON — ignore */
    }
    return { ok: false, error: `Jira API error (HTTP ${res.status})${detail}` };
  }
  return { ok: true, data: await res.json() };
}

function clampLimit(raw: unknown): number {
  return Math.min(Math.max(Number(raw ?? 20) || 20, 1), 50);
}

/** Quote a JQL string literal (escape backslashes + double quotes). */
function jqlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function safeRun<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
}

/** Project the relevant scalars off a raw Jira issue object into a shallow shape. */
function shapeIssue(raw: unknown): Record<string, unknown> {
  const o = (raw ?? {}) as Record<string, unknown>;
  const fields = (o.fields ?? {}) as Record<string, unknown>;
  const status = (fields.status ?? {}) as Record<string, unknown>;
  const priority = (fields.priority ?? {}) as Record<string, unknown>;
  const issueType = (fields.issuetype ?? {}) as Record<string, unknown>;
  const assignee = (fields.assignee ?? {}) as Record<string, unknown>;
  return {
    key: o.key,
    // Content (worst-case CUI) — included for commercial, WITHHELD for gov by the gate.
    summary: typeof fields.summary === "string" ? fields.summary : "",
    description:
      typeof fields.description === "string" ? fields.description : "",
    // Structural scalars — surfaced to gov.
    status: typeof status.name === "string" ? status.name : undefined,
    priority: typeof priority.name === "string" ? priority.name : undefined,
    issueType: typeof issueType.name === "string" ? issueType.name : undefined,
    assigneeAccountId:
      typeof assignee.accountId === "string" ? assignee.accountId : undefined,
    created: fields.created,
    updated: fields.updated,
    resolutiondate: fields.resolutiondate,
  };
}

// ── Tools ──────────────────────────────────────────────────────────────────

export async function jiraSearchIssues(args: ToolArgs, ctx: JiraToolContext) {
  return safeRun(async () => {
    const access = await resolveJiraAccess(ctx);
    if ("error" in access) return access;

    const limit = clampLimit(args.limit);

    let jql: string;
    if (typeof args.jql === "string" && args.jql.trim()) {
      jql = args.jql.trim();
    } else {
      const clauses: string[] = [];
      const projectKey =
        (typeof args.projectKey === "string" && args.projectKey) ||
        access.defaultProjectKey;
      if (projectKey) clauses.push(`project = ${jqlQuote(projectKey)}`);
      if (typeof args.status === "string" && args.status)
        clauses.push(`status = ${jqlQuote(args.status)}`);
      if (
        typeof args.assigneeAccountId === "string" &&
        args.assigneeAccountId
      )
        clauses.push(`assignee = ${jqlQuote(args.assigneeAccountId)}`);
      jql = clauses.length
        ? `${clauses.join(" AND ")} ORDER BY updated DESC`
        : "ORDER BY updated DESC";
    }

    const res = await jiraFetch(
      ctx,
      access,
      "GET",
      `/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=${limit}&fields=summary,status,priority,issuetype,assignee,created,updated,resolutiondate`,
    );
    if (!res.ok) return { error: res.error };

    const data = (res.data ?? {}) as Record<string, unknown>;
    const raw = Array.isArray(data.issues) ? data.issues : [];
    const issues = raw.map(shapeIssue);
    return { success: true, count: issues.length, issues };
  });
}

export async function jiraGetIssue(args: ToolArgs, ctx: JiraToolContext) {
  return safeRun(async () => {
    const issueKey =
      typeof args.issueKey === "string" ? args.issueKey.trim() : "";
    if (!issueKey) return { error: "issueKey (e.g. 'ABC-123') is required" };

    const access = await resolveJiraAccess(ctx);
    if ("error" in access) return access;

    const res = await jiraFetch(
      ctx,
      access,
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,status,priority,issuetype,assignee,created,updated,resolutiondate`,
    );
    if (!res.ok) return { error: res.error };

    return { success: true, issue: shapeIssue(res.data) };
  });
}

export async function jiraListProjects(args: ToolArgs, ctx: JiraToolContext) {
  return safeRun(async () => {
    const access = await resolveJiraAccess(ctx);
    if ("error" in access) return access;

    const limit = clampLimit(args.limit);
    const res = await jiraFetch(
      ctx,
      access,
      "GET",
      `/rest/api/3/project/search?maxResults=${limit}`,
    );
    if (!res.ok) return { error: res.error };

    const data = (res.data ?? {}) as Record<string, unknown>;
    const raw = Array.isArray(data.values) ? data.values : [];
    const projects = raw.map((p) => {
      const o = (p ?? {}) as Record<string, unknown>;
      return {
        id: o.id,
        key: o.key,
        // Content (name/description) — included for commercial, WITHHELD for gov.
        name: typeof o.name === "string" ? o.name : "",
        projectTypeKey: o.projectTypeKey,
      };
    });
    return { success: true, count: projects.length, projects };
  });
}

export async function jiraCreateIssue(args: ToolArgs, ctx: JiraToolContext) {
  return safeRun(async () => {
    const summary = typeof args.summary === "string" ? args.summary.trim() : "";
    const issueType =
      typeof args.issueType === "string" ? args.issueType.trim() : "";
    if (!summary) return { error: "summary is required" };
    if (!issueType) return { error: "issueType is required (e.g. 'Task')" };

    const access = await resolveJiraAccess(ctx);
    if ("error" in access) return access;

    const projectKey =
      (typeof args.projectKey === "string" && args.projectKey) ||
      access.defaultProjectKey;
    if (!projectKey) {
      return {
        error:
          "projectKey is required (none provided and the Jira integration has no defaultProjectKey configured).",
      };
    }

    const description =
      typeof args.description === "string" && args.description
        ? args.description
        : undefined;

    // Jira Cloud v3 expects an Atlassian Document Format body for `description`.
    const fields: Record<string, unknown> = {
      project: { key: projectKey },
      summary,
      issuetype: { name: issueType },
    };
    if (description) {
      fields.description = {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: description }],
          },
        ],
      };
    }

    const res = await jiraFetch(ctx, access, "POST", `/rest/api/3/issue`, {
      fields,
    });
    if (!res.ok) return { error: res.error };

    const o = (res.data ?? {}) as Record<string, unknown>;
    // The created entity → re-gated structurally for gov (key only).
    return { success: true, issue: { key: o.key } };
  });
}

// ── Dispatch ─────────────────────────────────────────────────────────────

/**
 * Map of Jira tool name → executor. Returns `null` if the name is not a Jira tool,
 * so the parent dispatcher falls through to other tool families.
 */
export async function executeJiraTool(
  name: string,
  args: ToolArgs,
  ctx: JiraToolContext,
): Promise<unknown | null> {
  switch (name) {
    case "jira_search_issues":
      return jiraSearchIssues(args, ctx);
    case "jira_get_issue":
      return jiraGetIssue(args, ctx);
    case "jira_list_projects":
      return jiraListProjects(args, ctx);
    case "jira_create_issue":
      return jiraCreateIssue(args, ctx);
    default:
      return null;
  }
}

/** Names of all Jira tools — for O(1) membership in the central dispatcher. */
export const JIRA_TOOL_NAMES: ReadonlySet<string> = new Set([
  "jira_search_issues",
  "jira_get_issue",
  "jira_list_projects",
  "jira_create_issue",
]);
