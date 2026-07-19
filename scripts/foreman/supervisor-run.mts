// Foreman supervisor — the I/O side of the outcome-grooming loop (the pure
// decision core is src/lib/foreman/supervisor.ts). Gathers each parked (review)
// ticket's facts, runs a grooming judgment on Foreman's OWN Claude creds (never a
// human seat), and executes the verdict EVENT-FIRST then mutate — idempotent,
// reversible, dry-mode aware. Called by run.mts's supervisorPass() on idle ticks.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "@/lib/db/client";
import { runModelTurn, type ModelCredential, type TenantClass } from "@/lib/ai/egress";
import { getForemanClaudeCreds } from "@/lib/ai/foreman-claude-subscription";
import { getForemanGithubToken } from "@/lib/ai/foreman-github-pat";
import { parsePrUrl, fetchPr, fetchDiff, type FetchLike } from "@/lib/foreman/approval-recommendation";
import { pickParkEvent, PARKED_EVENT_KINDS } from "@/lib/foreman/observe";
import {
  parseGroomingReply,
  decideVerdict,
  buildGroomingPrompt,
  isHumanSuppressed,
  selectWithinCap,
  type SupervisorConfig,
  type SupervisorFacts,
  type GroomingVerdict,
} from "@/lib/foreman/supervisor";
import { getForemanSupervisorSettings } from "@/lib/foreman/supervisor-settings";
import * as db from "./db.mjs";
import * as obs from "./observe.mjs";

const exec = promisify(execFile);
const REPO = process.env.FOREMAN_REPO ?? process.cwd();
const ANALYSIS_MODEL = "sonnet";

const GROOMING_SYSTEM =
  "You are Foreman's supervisor. A pull request was produced by an autonomous coding " +
  "agent and PARKED for review. Decide, from the ticket and the PR diff, whether the " +
  "ticket's intent is ALREADY on the main branch independent of this draft (delivered), " +
  "and whether the ticket duplicates another listed ticket. Be conservative: only claim " +
  "delivered/duplicate when the evidence is clear. The diff may be condensed — never treat " +
  "truncation as a gap. Reply with ONLY the requested compact JSON object, no prose.";

/** A parked (review) ticket + the facts the grooming judgment reasons over. */
export interface ReviewItem {
  id: string;
  orgId: string;
  ref: string;
  title: string;
  description: string;
  columnKey: string;
  prUrl: string | null;
  parkReason: string;
  parkKind: string;
  parkedAtMs: number;
  updatedAtMs: number;
  lastCommentAtMs: number | null;
}

/** The delivery orgs (distinct org ids across every autonomous-delivery project). */
export async function deliveryOrgIds(): Promise<string[]> {
  const pool = await db.deliveryProjects();
  return [...new Set(pool.map((p) => p.orgId))];
}

/** Reasons that mean the risk-gate parked a GREEN build for scope/sensitivity
 *  (a human-approval gate) rather than a failure — these are NOT re-queue-eligible. */
function isScopeOrSensitiveGate(parkReason: string): boolean {
  return /sensitive path|schema \/ migration|files changed \(>|lines changed \(>/i.test(parkReason);
}

/** Current main HEAD sha (short) — the daemon runs supervisorPass while checked
 *  out on main, so this is the sha a fresh re-queued build would target. */
async function currentMainSha(): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", REPO, "rev-parse", "--short", "HEAD"]);
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

/** List the parked (review) tickets for one org, each with its selected park event
 *  (reason + kind + PR url) and the timestamps the human-respect check needs.
 *  Mirrors the review-item + park-event join freshMentions uses. */
export async function gatherReviewItems(orgId: string): Promise<ReviewItem[]> {
  const pool = (await db.deliveryProjects()).filter((p) => p.orgId === orgId);
  if (pool.length === 0) return [];
  const items = await prisma.workItem.findMany({
    where: { projectId: { in: pool.map((p) => p.projectId) }, columnKey: "review" },
    select: { id: true, orgId: true, title: true, description: true, columnKey: true, updatedAt: true, projectId: true, ticketNumber: true },
  });
  if (items.length === 0) return [];
  const keyByProject = new Map(pool.map((p) => [p.projectId, p.projectKey] as const));
  const events = await prisma.foremanEvent.findMany({
    where: { workItemId: { in: items.map((i) => i.id) }, kind: { in: [...PARKED_EVENT_KINDS] } },
    orderBy: [{ ts: "desc" }, { id: "desc" }],
    select: { id: true, workItemId: true, kind: true, ts: true, message: true, data: true },
  });
  const eventsByItem = new Map<string, typeof events>();
  for (const e of events) {
    if (!e.workItemId) continue;
    const list = eventsByItem.get(e.workItemId) ?? [];
    list.push(e);
    eventsByItem.set(e.workItemId, list);
  }
  const comments = await prisma.comment.findMany({
    where: { workItemId: { in: items.map((i) => i.id) } },
    orderBy: [{ createdAt: "desc" }],
    select: { workItemId: true, createdAt: true },
  });
  const lastCommentByItem = new Map<string, number>();
  for (const c of comments) {
    if (c.workItemId && !lastCommentByItem.has(c.workItemId)) lastCommentByItem.set(c.workItemId, c.createdAt.getTime());
  }
  const out: ReviewItem[] = [];
  for (const it of items) {
    const evs = eventsByItem.get(it.id) ?? [];
    const ev = pickParkEvent(evs) as (typeof events)[number] | null;
    const data = (ev?.data ?? {}) as { prUrl?: string; reason?: string };
    const parkReason = (data.reason ?? ev?.message ?? "").toString();
    out.push({
      id: it.id,
      orgId: it.orgId,
      ref: `${keyByProject.get(it.projectId) ?? "COSMOS"}-${it.ticketNumber}`,
      title: it.title,
      description: it.description ?? "",
      columnKey: it.columnKey,
      prUrl: typeof data.prUrl === "string" ? data.prUrl : null,
      parkReason,
      parkKind: ev?.kind ?? "parked",
      parkedAtMs: ev?.ts ? ev.ts.getTime() : it.updatedAt.getTime(),
      updatedAtMs: it.updatedAt.getTime(),
      lastCommentAtMs: lastCommentByItem.get(it.id) ?? null,
    });
  }
  return out;
}

const FOREMAN_PATH = /^(scripts\/foreman\/|src\/lib\/foreman\/)/;

/** Does the PR touch Foreman's own code (scripts/foreman, src/lib/foreman)? Such a
 *  change must NEVER be auto-closed as delivered — decideVerdict escalates it. Uses
 *  the PR FILES list (not the possibly-truncated diff), since a truncated diff could
 *  hide a sensitive-path header and defeat this hard safety invariant. */
function filesTouchForemanPath(files: string[]): boolean {
  return files.some((f) => FOREMAN_PATH.test(f));
}

/** GET the PR's changed file paths (up to 100), or [] on failure — independent of
 *  the diff text so truncation can never hide a sensitive path. */
async function fetchPrFiles(
  fetchImpl: FetchLike,
  token: string,
  t: { owner: string; repo: string; number: number },
): Promise<string[]> {
  const res = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}/pulls/${t.number}/files?per_page=100`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "cosmos-foreman",
      },
    },
  );
  if (!res.ok) return [];
  const arr = (await res.json()) as unknown;
  return Array.isArray(arr)
    ? arr.map((f) => (f as { filename?: string }).filename).filter((x): x is string => typeof x === "string")
    : [];
}

/** Run the grooming judgment for one item on Foreman's own creds, and assemble the
 *  full SupervisorFacts the pure decideVerdict consumes. GitHub/model unavailable
 *  ⇒ a safe not-delivered/not-dup judgment (decideVerdict then leaves or requeues). */
export async function gatherFacts(
  item: ReviewItem,
  otherTickets: { key: string; title: string }[],
  mainSha: string,
  tenantClass: TenantClass,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<SupervisorFacts> {
  let diff = "";
  let files: string[] = [];
  let judgment = { delivered: false, deliveredConfidence: 0, dupOf: null as string | null, dupConfidence: 0, evidence: "" };
  const token = await getForemanGithubToken(item.orgId);
  const target = item.prUrl ? parsePrUrl(item.prUrl) : null;
  if (token && target) {
    const pr = await fetchPr(fetchImpl, token, target);
    if (pr) {
      diff = await fetchDiff(fetchImpl, token, target);
      files = await fetchPrFiles(fetchImpl, token, target);
    }
  }
  const creds = await getForemanClaudeCreds(item.orgId);
  if (creds && (diff || !item.prUrl)) {
    try {
      const credential: ModelCredential = { kind: "oauth", token: creds.accessToken };
      const reply = await runModelTurn({
        ctx: { orgId: item.orgId, conversationId: `foreman-groom-${item.id}`, turn: 0, tenantClass, mode: "enforced" },
        system: GROOMING_SYSTEM,
        messages: [{ role: "user", content: buildGroomingPrompt({ ticket: { key: item.ref, title: item.title, description: item.description }, prDiff: diff, parkReason: item.parkReason, otherTickets }) }],
        tools: [],
        model: ANALYSIS_MODEL,
        maxTokens: 500,
        credential,
      });
      judgment = parseGroomingReply(reply.text);
    } catch {
      // model unavailable ⇒ keep the safe default (leave/requeue only)
    }
  }
  const lastRequeuedSha = await db.lastRequeuedSha(item.id);
  return {
    hasPr: item.prUrl !== null,
    judgment,
    requeue: {
      parkReason: item.parkReason,
      checkLog: item.parkReason,
      parkedAtMs: item.parkedAtMs,
      lastInfraFixAtMs: null, // signature-only requeue for now (conservative)
      currentMainSha: mainSha,
      lastRequeuedSha,
      isScopeOrSensitiveGate: isScopeOrSensitiveGate(item.parkReason),
    },
    touchesSensitiveForemanPath: filesTouchForemanPath(files),
    agentAskedForInput: item.parkKind === "needs-input",
  };
}

/** Close a draft PR with a comment, using the gh CLI (GH_TOKEN is set in the
 *  daemon env by configureGithubAuth; child inherits it). Best-effort. */
async function closePr(prUrl: string, comment: string): Promise<boolean> {
  const t = parsePrUrl(prUrl);
  if (!t) return false;
  try {
    await exec("gh", ["pr", "close", String(t.number), "--repo", `${t.owner}/${t.repo}`, "--comment", comment], { env: process.env });
    return true;
  } catch (e) {
    // Already-closed/merged is a benign no-op; any other error is a real failure the
    // caller records (prClosed:false in the event) so an operator sees it.
    return /already|not open|closed|merged/i.test(String(e));
  }
}

/** Execute a verdict: EVENT FIRST (records action + prior state → idempotent +
 *  reversible), THEN mutate. Dry mode only records a `[dry]` event, never mutates. */
export async function executeVerdict(item: ReviewItem, v: GroomingVerdict, dry: boolean, sha: string): Promise<void> {
  if (v.kind === "leave") return;
  if (dry) {
    await obs.track({
      workItemId: item.id, orgId: item.orgId, ticketKey: item.ref, kind: "groomed",
      message: `[dry] ${v.kind}: ${v.evidence}`,
      data: { action: v.kind, dry: true, evidence: v.evidence, dupOf: v.dupOf ?? null, sha },
    });
    return;
  }
  // Do the external PR close FIRST (for close/dedup) so the event can record whether
  // it actually succeeded — no "event says closed but the PR is still open".
  let prClosed: boolean | undefined;
  if (v.kind === "deliver-close" && item.prUrl) {
    prClosed = await closePr(item.prUrl, `Delivered on main (Foreman supervisor): ${v.evidence}`);
  } else if (v.kind === "dedup-consolidate" && item.prUrl) {
    prClosed = await closePr(item.prUrl, `Duplicate of ${v.dupOf} (Foreman supervisor): ${v.evidence}`);
  }
  await obs.trackStrict({
    workItemId: item.id, orgId: item.orgId, ticketKey: item.ref, kind: "groomed",
    message: `${v.kind}: ${v.evidence}`,
    data: { action: v.kind, evidence: v.evidence, dupOf: v.dupOf ?? null, sha, priorColumn: item.columnKey, prUrl: item.prUrl, prClosed: prClosed ?? null },
  });
  switch (v.kind) {
    case "deliver-close":
      await db.moveColumn(item.id, "done");
      break;
    case "dedup-consolidate":
      await db.comment(item.id, `Consolidated into ${v.dupOf} by the supervisor: ${v.evidence}`);
      await db.moveColumn(item.id, "done");
      break;
    case "requeue":
      await db.moveColumn(item.id, "backlog"); // planner re-picks a FRESH build vs current main
      break;
    case "escalate":
      await db.comment(item.id, `Supervisor needs a human: ${v.evidence}`);
      break;
  }
}

/** Decide the verdict for one item: skip (leave) if a human acted since the last
 *  groom; otherwise gather facts + decide. Execution is done by the caller (after
 *  the per-pass cap). */
export async function groomOne(
  item: ReviewItem,
  otherTickets: { key: string; title: string }[],
  cfg: SupervisorConfig,
  mainSha: string,
  tenantClass: TenantClass,
): Promise<GroomingVerdict> {
  const last = await db.lastGroomedEvent(item.id);
  // Idempotency: if we already groomed this item at the CURRENT main sha, nothing has
  // advanced — don't re-groom (stops escalate from re-firing every pass). A new sha or
  // a human action re-opens it.
  const lastSha = last ? (last.data as { sha?: unknown }).sha : undefined;
  if (last && typeof lastSha === "string" && lastSha === mainSha) {
    return { kind: "leave", confidence: 1, evidence: "already groomed at this sha" };
  }
  if (
    isHumanSuppressed({
      lastGroomedAtMs: last ? last.ts.getTime() : null,
      updatedAtMs: item.updatedAtMs,
      lastCommentAtMs: item.lastCommentAtMs,
      lastHumanMoveAtMs: null,
    })
  ) {
    return { kind: "leave", confidence: 1, evidence: "human acted since last groom" };
  }
  const facts = await gatherFacts(item, otherTickets, mainSha, tenantClass);
  return decideVerdict(facts, cfg);
}

export { currentMainSha };

let lastSupervisorPassMs = 0;
const SUPERVISOR_MIN_INTERVAL_MS = 5 * 60_000;

/** One supervisor pass over every delivery org's parked tickets. Called from the
 *  daemon loop on idle ticks (queue drained). No-op when mode=off or the
 *  min-interval has not elapsed. Per-org isolated: one org's error never aborts the
 *  others. Executes verdicts within the per-pass cap; escalate/leave don't consume
 *  it. `log` is the daemon's logger, threaded in so this file stays I/O-focused. */
export async function runSupervisorPass(log: (m: string) => void): Promise<void> {
  // Global kill switch (env). When not "off", per-org DB settings govern each org.
  if ((process.env.FOREMAN_SUPERVISOR ?? "off").toLowerCase().trim() === "off") return;
  if (Date.now() - lastSupervisorPassMs < SUPERVISOR_MIN_INTERVAL_MS) return;
  lastSupervisorPassMs = Date.now();
  const sha = await currentMainSha();
  const orgIds = await deliveryOrgIds();
  for (const orgId of orgIds) {
    try {
      const settings = await getForemanSupervisorSettings(orgId);
      if (settings.mode === "off") continue;
      const dry = settings.mode === "dry";
      const cfg: SupervisorConfig = {
        deliverClose: settings.deliverClose, requeue: settings.requeue, dedup: settings.dedup,
        escalate: settings.escalate, confidenceThreshold: settings.confidenceThreshold, perPassCap: settings.perPassCap,
      };
      const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { tenantClass: true } });
      // Organization.tenantClass is the uppercase Prisma enum (GOV/COMMERCIAL);
      // egress TenantClass is lowercase — normalize so the gov CUI tripwire fires.
      const tenantClass: TenantClass = org?.tenantClass === "GOV" ? "gov" : "commercial";
      const items = await gatherReviewItems(orgId);
      if (items.length === 0) continue;
      const index = items.map((i) => ({ key: i.ref, title: i.title }));
      const verdicts: { verdict: GroomingVerdict; item: ReviewItem }[] = [];
      for (const item of items) {
        const others = index.filter((t) => t.key !== item.ref);
        verdicts.push({ item, verdict: await groomOne(item, others, cfg, sha, tenantClass) });
      }
      const { act, deferred } = selectWithinCap(verdicts, cfg.perPassCap);
      for (const a of act) await executeVerdict(a.item, a.verdict, dry, sha);
      const acted = act.filter((a) => a.verdict.kind !== "leave").length;
      if (acted) log(`supervisor: ${dry ? "[dry] " : ""}${acted} action(s) over ${items.length} parked item(s) (org ${orgId})`);
      if (deferred.length) log(`supervisor: ${deferred.length} action(s) deferred by per-pass cap (org ${orgId})`);
    } catch (e) {
      log(`supervisor pass error (org ${orgId}): ${String(e)}`);
    }
  }
}
