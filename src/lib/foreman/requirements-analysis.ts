/**
 * Per-item AI requirements-coverage analysis for the Foreman console's
 * Awaiting-Approval section (COSMOS-116).
 *
 * For a parked (review) item that HAS a PR, a steward can expand an "AI Analysis"
 * report that judges the item's PR diff against the ORIGINAL ticket's description
 * and acceptance criteria: per-criterion met / partial / missing, notable gaps,
 * risks the change introduces, and whether the change is complete. It complements
 * the COSMOS-111 approve/rework/rebuild recommendation (which can cite it).
 *
 * Like every other model call it goes through the single CUI-blind egress
 * chokepoint (`runModelTurn`) — never the provider directly — on Foreman's OWN
 * connected subscription ({@link getForemanClaudeCreds}), so it never consumes a
 * human seat's token. The read-only GitHub PR plumbing (head SHA + diff) is the
 * SAME code the recommendation uses, imported from ./approval-recommendation.
 * Results are CACHED per PR head SHA so the console's 15s status poll never
 * recomputes an unchanged build; a new push (new head SHA) invalidates naturally.
 *
 * No-PR items never reach here — the console disables the button with a tooltip
 * (nothing to analyze) — but the orchestrator still degrades gracefully if asked.
 */
import { runModelTurn, type ModelCredential, type TenantClass } from "@/lib/ai/egress";
import { getForemanClaudeCreds } from "@/lib/ai/foreman-claude-subscription";
import { getForemanGithubToken } from "@/lib/ai/foreman-github-pat";
import { parsePrUrl, fetchPr, fetchDiff, type FetchLike } from "./approval-recommendation";

// Re-export the injected fetch seam so the test (and any future caller) can type
// its mock against the same contract without reaching into the sibling module.
export type { FetchLike } from "./approval-recommendation";

export type CriterionStatus = "met" | "partial" | "missing";

export interface CriterionAssessment {
  /** The acceptance criterion (verbatim when given, else derived from the description). */
  criterion: string;
  status: CriterionStatus;
  /** One concise line on why the diff does / doesn't satisfy it. */
  note: string;
}

export interface RequirementsReport {
  /** One-sentence verdict on how well the diff covers the ticket. */
  summary: string;
  criteria: CriterionAssessment[];
  /** Notable gaps between the ticket's intent and the diff. */
  gaps: string[];
  /** Risks the change introduces (regressions, edge cases, security). */
  risks: string[];
  /** Whether the model judged the change complete against the ticket. */
  complete: boolean;
}

/** The verdict for a parked item that never produced a PR. The console disables
 *  the button for these, so this is a defensive fallback only. */
export const NO_PR_REPORT: RequirementsReport = {
  summary: "Nothing was built to analyze — the agent produced no pull request.",
  criteria: [],
  gaps: [],
  risks: [],
  complete: false,
};

/** Graceful fallback when the PR can't be analyzed (GitHub/creds/model down). It
 *  is deliberately NOT cached, so a transient failure recovers on the next poll. */
const UNAVAILABLE_REPORT: RequirementsReport = {
  summary:
    "Couldn't analyze the PR automatically — open it and review the diff against the ticket yourself.",
  criteria: [],
  gaps: [],
  risks: [],
  complete: false,
};

const ANALYSIS_MODEL = "sonnet";
const MAX_TOKENS = 900;
const MAX_DIFF_CHARS = 12_000;
const MAX_DESC_CHARS = 4_000;

const ANALYSIS_SYSTEM =
  "You are reviewing a pull request that an autonomous coding agent produced for a ticket and " +
  "PARKED for a human's approval before it ships to production. Judge the DIFF STRICTLY against " +
  "the ORIGINAL ticket's description and acceptance criteria — a change that merely looks plausible " +
  "but doesn't satisfy the requirements is NOT met.\n" +
  "For EACH acceptance criterion decide:\n" +
  "- met: the diff fully and correctly satisfies it.\n" +
  "- partial: it's addressed but incompletely (a gap, a missing test, an unhandled edge case).\n" +
  "- missing: the diff does not address it at all.\n" +
  "If no explicit acceptance criteria are given, derive the concrete requirements from the description " +
  "and assess THOSE. Then list notable gaps between the ticket's intent and the diff, risks the change " +
  "introduces (regressions, security, edge cases), and whether the change is complete.\n" +
  'Reply with ONLY a compact JSON object: {"summary":"<one sentence>","criteria":[{"criterion":"<text>","status":"met|partial|missing","note":"<one concise sentence>"}],"gaps":["<gap>"],"risks":["<risk>"],"complete":true|false}. ' +
  "No prose, no markdown, no code fences.";

/* -------------------------------------------------------------------------- */
/*  Pure parsing — the model-output → typed-report mapping                     */
/* -------------------------------------------------------------------------- */

function coerceStatus(raw: unknown): CriterionStatus {
  const s = typeof raw === "string" ? raw.toLowerCase().trim() : "";
  // Anything unrecognized maps to `partial` — never silently claim `met`.
  return s === "met" || s === "missing" ? s : "partial";
}

function oneLine(raw: unknown, cap: number): string {
  let s = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (s.length > cap) s = `${s.slice(0, cap - 1).trimEnd()}…`;
  return s;
}

function toStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => oneLine(x, 240))
    .filter((x) => x.length > 0)
    .slice(0, 12);
}

function normalizeCriterion(raw: unknown): CriterionAssessment | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const criterion = oneLine(o.criterion, 240);
  if (!criterion) return null;
  return {
    criterion,
    status: coerceStatus(o.status),
    note: oneLine(o.note, 240) || "No note provided.",
  };
}

/**
 * Map the model's raw reply to a typed {@link RequirementsReport}. PURE +
 * testable: extracts the first JSON object (tolerating stray prose or code
 * fences), coerces each criterion's status to one of met/partial/missing
 * (defaulting an unknown/absent status to `partial`, never `met`), and normalizes
 * the free-text fields to single capped lines.
 */
export function parseRequirementsReport(raw: string): RequirementsReport {
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

  const criteria = Array.isArray(parsed.criteria)
    ? parsed.criteria
        .map((c) => normalizeCriterion(c))
        .filter((c): c is CriterionAssessment => c !== null)
    : [];
  const gaps = toStringList(parsed.gaps);
  const risks = toStringList(parsed.risks);
  const complete = parsed.complete === true;

  let summary = oneLine(parsed.summary, 400);
  if (!summary) {
    summary = criteria.length
      ? "Analysis complete — see the per-criterion breakdown below."
      : "No requirements analysis was produced.";
  }

  return { summary, criteria, gaps, risks, complete };
}

/* -------------------------------------------------------------------------- */
/*  Prompt assembly                                                            */
/* -------------------------------------------------------------------------- */

function buildUserPrompt(input: {
  ticket: { title: string; description: string; acceptanceCriteria: string[] };
  diff: string;
}): string {
  const { ticket, diff } = input;
  const criteria = ticket.acceptanceCriteria.length
    ? ticket.acceptanceCriteria.map((c) => `- ${c}`).join("\n")
    : "(none given — derive the requirements from the description)";
  const description = ticket.description.trim().slice(0, MAX_DESC_CHARS) || "(no description)";
  return [
    `Ticket title: ${ticket.title || "(untitled)"}`,
    "",
    `Ticket description:\n${description}`,
    "",
    `Acceptance criteria:\n${criteria}`,
    "",
    "PR diff:",
    diff.trim() || "(empty diff)",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/*  Cache — keyed per PR head SHA (so the 15s status poll never recomputes)    */
/* -------------------------------------------------------------------------- */

const cache = new Map<string, RequirementsReport>();

function cacheKey(orgId: string, t: { owner: string; repo: string }, headSha: string): string {
  return `${orgId}:${t.owner}/${t.repo}#${headSha}`;
}

/** Test-only: drop the process-wide cache so cases don't bleed into each other. */
export function _resetAnalysisCacheForTests(): void {
  cache.clear();
}

/* -------------------------------------------------------------------------- */
/*  Orchestrator                                                               */
/* -------------------------------------------------------------------------- */

export interface AnalyzeInput {
  orgId: string;
  tenantClass: TenantClass;
  workItemId: string;
  /** The parked item's PR URL, or null when the agent produced no PR. */
  prUrl: string | null;
  /** The ORIGINAL ticket's requirements, resolved server-side from the work item. */
  ticket: { title: string; description: string; acceptanceCriteria: string[] };
}

/** Injectable seams so the orchestrator is testable without network/DB/model. */
export interface AnalyzeDeps {
  fetchImpl?: FetchLike;
  runModelTurnImpl?: typeof runModelTurn;
  getForemanCredsImpl?: typeof getForemanClaudeCreds;
  getGitHubTokenImpl?: (orgId: string) => Promise<string | null>;
}

export interface AnalysisResult extends RequirementsReport {
  /** True when served from the per-SHA cache (no fresh model call this poll). */
  cached: boolean;
}

/**
 * Produce the requirements-coverage report for one parked item. No PR ⇒ the
 * fixed {@link NO_PR_REPORT}. Otherwise fetch the PR head SHA (cache key) and
 * diff, and — on a cache miss — run the analysis via the egress chokepoint on
 * Foreman's own subscription, caching the report per head SHA.
 */
export async function analyzeRequirements(
  input: AnalyzeInput,
  deps: AnalyzeDeps = {},
): Promise<AnalysisResult> {
  if (!input.prUrl) return { ...NO_PR_REPORT, cached: false };

  const target = parsePrUrl(input.prUrl);
  if (!target) return { ...UNAVAILABLE_REPORT, cached: false };

  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const getToken =
    deps.getGitHubTokenImpl ?? getForemanGithubToken;

  const token = await getToken(input.orgId);
  if (!token) return { ...UNAVAILABLE_REPORT, cached: false };

  // 1. PR metadata → head SHA (the cache key). Resolve it before anything expensive.
  const pr = await fetchPr(fetchImpl, token, target);
  if (!pr) return { ...UNAVAILABLE_REPORT, cached: false };

  const key = cacheKey(input.orgId, target, pr.headSha);
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

  // 2. The diff the analysis reasons over, against the ticket's requirements.
  const diff = await fetchDiff(fetchImpl, token, target);

  // 3. Foreman's own subscription creds — its usage never touches a human seat.
  const getCreds = deps.getForemanCredsImpl ?? getForemanClaudeCreds;
  const creds = await getCreds(input.orgId);
  if (!creds) return { ...UNAVAILABLE_REPORT, cached: false };

  const credential: ModelCredential = { kind: "oauth", token: creds.accessToken };
  const runTurn = deps.runModelTurnImpl ?? runModelTurn;

  let report: RequirementsReport;
  try {
    const reply = await runTurn({
      ctx: {
        orgId: input.orgId,
        conversationId: `foreman-requirements-${input.workItemId}`,
        turn: 0,
        tenantClass: input.tenantClass,
        mode: "enforced",
      },
      system: ANALYSIS_SYSTEM,
      messages: [{ role: "user", content: buildUserPrompt({ ticket: input.ticket, diff: diffCap(diff) }) }],
      tools: [],
      model: ANALYSIS_MODEL,
      maxTokens: MAX_TOKENS,
      credential,
    });
    report = parseRequirementsReport(reply.text);
  } catch {
    return { ...UNAVAILABLE_REPORT, cached: false };
  }

  cache.set(key, report);
  return { ...report, cached: false };
}

/** Belt-and-braces cap: fetchDiff already truncates, but guard the prompt size
 *  in case a caller injects a fetch that doesn't. */
function diffCap(diff: string): string {
  return diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated]` : diff;
}
