/**
 * Per-item AI recommendation for the Foreman console's Awaiting-Approval section.
 *
 * For a parked (review) item the console shows a small "Recommend: Approve /
 * Rework / Rebuild" badge + one-line rationale:
 *   - NO PR (agent didn't complete / empty diff / failed pre-PR) → a static
 *     Rebuild ({@link NO_PR_RECOMMENDATION}); nothing was built to approve.
 *   - HAS a PR → a Claude analysis of the ACTUAL PR (diff + check results + the
 *     park reason), run on Foreman's OWN connected subscription
 *     ({@link getForemanClaudeCreds}) so it doesn't consume a human seat's token.
 *
 * The model call goes through the single CUI-blind egress chokepoint
 * (`runModelTurn`) like every other model call — never the provider directly —
 * passing Foreman's credential in by value. Results are CACHED per PR head SHA
 * so the console's 15s status poll never recomputes an unchanged build; a new
 * push (new head SHA) invalidates naturally by keying on the SHA.
 */
import { runModelTurn, type ModelCredential, type TenantClass } from "@/lib/ai/egress";
import { getForemanClaudeCreds } from "@/lib/ai/foreman-claude-subscription";
import { getForemanGithubToken } from "@/lib/ai/foreman-github-pat";

export type RecommendationKind = "approve" | "rework" | "rebuild";

export interface ApprovalRecommendation {
  recommendation: RecommendationKind;
  rationale: string;
}

/** The fixed verdict for a parked item that never produced a PR. */
export const NO_PR_RECOMMENDATION: ApprovalRecommendation = {
  recommendation: "rebuild",
  rationale: "Nothing was built to approve — the agent produced no pull request.",
};

/** Graceful fallback when the PR can't be analyzed (GitHub/creds/model down). It
 *  is deliberately NOT cached, so a transient failure recovers on the next poll. */
const UNAVAILABLE_RECOMMENDATION: ApprovalRecommendation = {
  recommendation: "rework",
  rationale: "Couldn't analyze the PR automatically — open it and review the diff yourself.",
};

const ANALYSIS_MODEL = "sonnet";
const MAX_TOKENS = 400;
const MAX_DIFF_CHARS = 12_000;

const ANALYSIS_SYSTEM =
  "You are reviewing a pull request that an autonomous coding agent produced and " +
  "PARKED for a human's approval before it ships to production. Weigh the diff, the " +
  "CI check results, and the reason it was parked, then give ONE recommendation:\n" +
  "- approve: the change correctly and safely satisfies its ticket, checks pass, and it's ready to merge & deploy.\n" +
  "- rework: on the right track but has fixable gaps (a bug, missing tests, an unaddressed edge case) — better to resume the existing build with guidance than to start over.\n" +
  "- rebuild: wrong-headed, empty, or off-target enough that starting fresh beats patching it.\n" +
  'Reply with ONLY a compact JSON object: {"recommendation":"approve|rework|rebuild","rationale":"<one concise sentence>"}. ' +
  "No prose, no markdown, no code fences.";

/* -------------------------------------------------------------------------- */
/*  Pure parsing — the model-output → typed-recommendation mapping             */
/* -------------------------------------------------------------------------- */

/**
 * Map the model's raw reply to a typed {@link ApprovalRecommendation}. PURE +
 * testable: extracts the first JSON object (tolerating stray prose or code
 * fences), coerces `recommendation` to one of the three verbs (defaulting to the
 * human-in-the-loop `rework` when absent/unknown), and normalizes the rationale
 * to a single capped line.
 */
export function parseRecommendation(raw: string): ApprovalRecommendation {
  const text = (raw ?? "").trim();
  let parsed: Record<string, unknown> = {};
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj && typeof obj === "object") parsed = obj as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }

  const recRaw =
    typeof parsed.recommendation === "string" ? parsed.recommendation.toLowerCase().trim() : "";
  const recommendation: RecommendationKind =
    recRaw === "approve" || recRaw === "rework" || recRaw === "rebuild" ? recRaw : "rework";

  let rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
  rationale = rationale.replace(/\s+/g, " ");
  if (rationale.length > 240) rationale = `${rationale.slice(0, 239).trimEnd()}…`;
  if (!rationale) rationale = "No rationale provided.";

  return { recommendation, rationale };
}

/* -------------------------------------------------------------------------- */
/*  GitHub REST (read-only) — fetch the PR head SHA, diff, and check results   */
/* -------------------------------------------------------------------------- */

/** Minimal fetch signature we depend on — lets tests inject a mock (mirrors
 *  {@link file://../ai/executors/github.ts}'s FetchLike). */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

/** Parse `https://github.com/OWNER/REPO/pull/NUMBER` → its parts, or null. */
export function parsePrUrl(prUrl: string): { owner: string; repo: string; number: number } | null {
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

function ghHeaders(token: string, accept: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cosmos-foreman",
  };
}

interface PrTarget {
  owner: string;
  repo: string;
  number: number;
}

/** GET the PR JSON → its head SHA + title/body (the head SHA is the cache key).
 *  Exported so the sibling requirements-analysis module (COSMOS-116) reuses the
 *  exact same read-only GitHub plumbing rather than duplicating it. */
export async function fetchPr(
  fetchImpl: FetchLike,
  token: string,
  t: PrTarget,
): Promise<{ headSha: string; title: string; body: string } | null> {
  const res = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}/pulls/${t.number}`,
    { method: "GET", headers: ghHeaders(token, "application/vnd.github+json") },
  );
  if (!res.ok) return null;
  const o = (await res.json()) as Record<string, unknown>;
  const head = (o.head ?? {}) as Record<string, unknown>;
  const headSha = typeof head.sha === "string" ? head.sha : "";
  if (!headSha) return null;
  return {
    headSha,
    title: typeof o.title === "string" ? o.title : "",
    body: typeof o.body === "string" ? o.body : "",
  };
}

/** GET the unified diff for the PR (truncated), or "" on failure. Exported for
 *  reuse by the requirements-analysis module (COSMOS-116). */
export async function fetchDiff(fetchImpl: FetchLike, token: string, t: PrTarget): Promise<string> {
  const res = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}/pulls/${t.number}`,
    { method: "GET", headers: ghHeaders(token, "application/vnd.github.diff") },
  );
  if (!res.ok) return "";
  const diff = await res.text();
  return diff.length > MAX_DIFF_CHARS
    ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated]`
    : diff;
}

/** GET the check-runs for the head SHA and summarize their conclusions. */
async function fetchChecks(
  fetchImpl: FetchLike,
  token: string,
  t: PrTarget,
  headSha: string,
): Promise<string> {
  const res = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}/commits/${encodeURIComponent(headSha)}/check-runs`,
    { method: "GET", headers: ghHeaders(token, "application/vnd.github+json") },
  );
  if (!res.ok) return "No check results available.";
  const o = (await res.json()) as { check_runs?: unknown };
  const runs = Array.isArray(o.check_runs) ? o.check_runs : [];
  if (runs.length === 0) return "No checks have run.";
  return runs
    .map((r) => {
      const run = (r ?? {}) as Record<string, unknown>;
      const name = typeof run.name === "string" ? run.name : "check";
      const status = typeof run.status === "string" ? run.status : "unknown";
      const conclusion = typeof run.conclusion === "string" ? run.conclusion : status;
      return `- ${name}: ${conclusion}`;
    })
    .join("\n");
}

function buildUserPrompt(input: {
  reason: string | null;
  pr: { title: string; body: string };
  checks: string;
  diff: string;
}): string {
  return [
    `Park reason: ${input.reason?.trim() || "(none recorded)"}`,
    "",
    `PR title: ${input.pr.title || "(untitled)"}`,
    input.pr.body.trim() ? `PR description:\n${input.pr.body.trim().slice(0, 2000)}` : "PR description: (none)",
    "",
    `CI check results:\n${input.checks}`,
    "",
    "Diff:",
    input.diff.trim() || "(empty diff)",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/*  Cache — keyed per PR head SHA (so the 15s status poll never recomputes)    */
/* -------------------------------------------------------------------------- */

const cache = new Map<string, ApprovalRecommendation>();

function cacheKey(orgId: string, t: PrTarget, headSha: string): string {
  return `${orgId}:${t.owner}/${t.repo}#${headSha}`;
}

/** Test-only: drop the process-wide cache so cases don't bleed into each other. */
export function _resetRecommendationCacheForTests(): void {
  cache.clear();
}

/* -------------------------------------------------------------------------- */
/*  Orchestrator                                                               */
/* -------------------------------------------------------------------------- */

export interface RecommendInput {
  orgId: string;
  tenantClass: TenantClass;
  workItemId: string;
  /** The parked item's PR URL, or null when the agent produced no PR. */
  prUrl: string | null;
  /** The reason the item was parked (surfaced to the model). */
  reason: string | null;
}

/** Injectable seams so the orchestrator is testable without network/DB/model. */
export interface RecommendDeps {
  fetchImpl?: FetchLike;
  runModelTurnImpl?: typeof runModelTurn;
  getForemanCredsImpl?: typeof getForemanClaudeCreds;
  getGitHubTokenImpl?: (orgId: string) => Promise<string | null>;
}

export interface RecommendResult extends ApprovalRecommendation {
  /** True when served from the per-SHA cache (no fresh model call this poll). */
  cached: boolean;
}

/**
 * Produce the approval recommendation for one parked item. No PR ⇒ the fixed
 * Rebuild verdict. Otherwise fetch the PR head SHA (cache key), diff, and check
 * results, and — on a cache miss — run the Claude analysis via the egress
 * chokepoint on Foreman's own subscription, caching the verdict per head SHA.
 */
export async function recommendForApproval(
  input: RecommendInput,
  deps: RecommendDeps = {},
): Promise<RecommendResult> {
  if (!input.prUrl) return { ...NO_PR_RECOMMENDATION, cached: false };

  const target = parsePrUrl(input.prUrl);
  if (!target) return { ...UNAVAILABLE_RECOMMENDATION, cached: false };

  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const getToken =
    deps.getGitHubTokenImpl ?? getForemanGithubToken;

  const token = await getToken(input.orgId);
  if (!token) return { ...UNAVAILABLE_RECOMMENDATION, cached: false };

  // 1. PR metadata → head SHA. The SHA is both the cache key and the ref the
  //    check-runs are fetched for, so we resolve it before anything expensive.
  const pr = await fetchPr(fetchImpl, token, target);
  if (!pr) return { ...UNAVAILABLE_RECOMMENDATION, cached: false };

  const key = cacheKey(input.orgId, target, pr.headSha);
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

  // 2. The material the analysis reasons over.
  const [diff, checks] = await Promise.all([
    fetchDiff(fetchImpl, token, target),
    fetchChecks(fetchImpl, token, target, pr.headSha),
  ]);

  // 3. Foreman's own subscription creds — its usage never touches a human seat.
  const getCreds = deps.getForemanCredsImpl ?? getForemanClaudeCreds;
  const creds = await getCreds(input.orgId);
  if (!creds) return { ...UNAVAILABLE_RECOMMENDATION, cached: false };

  const credential: ModelCredential = { kind: "oauth", token: creds.accessToken };
  const runTurn = deps.runModelTurnImpl ?? runModelTurn;

  let rec: ApprovalRecommendation;
  try {
    const reply = await runTurn({
      ctx: {
        orgId: input.orgId,
        conversationId: `foreman-approval-${input.workItemId}`,
        turn: 0,
        tenantClass: input.tenantClass,
        mode: "enforced",
      },
      system: ANALYSIS_SYSTEM,
      messages: [
        { role: "user", content: buildUserPrompt({ reason: input.reason, pr, checks, diff }) },
      ],
      tools: [],
      model: ANALYSIS_MODEL,
      maxTokens: MAX_TOKENS,
      credential,
    });
    rec = parseRecommendation(reply.text);
  } catch {
    return { ...UNAVAILABLE_RECOMMENDATION, cached: false };
  }

  cache.set(key, rec);
  return { ...rec, cached: false };
}
