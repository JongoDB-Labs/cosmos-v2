// Foreman orchestrator: the control loop that wires the ten foreman modules into
// one autonomous-delivery daemon. It reads the pooled backlog (every project any
// org has opted into autonomous delivery for) and, for each ready ticket, runs
// the pipeline — dedup gate -> clarity gate -> coding agent -> checks
// -> risk classification -> ship-or-gate — then loops. Every model call goes
// through runAgent (subscription-enforced), and the only writes to prod
// (merge/tag/deploy) live behind BOTH the org autonomy toggle and the armed
// (non-DRY) path. Nothing here crashes the loop: a per-ticket try/catch isolates
// each build, a ship-failure gates the ticket and restores main, and a
// control-plane hiccup idles rather than tearing the daemon down.
//
// Sibling modules are imported with the `.mjs` specifier (not `.mts`): under this
// repo's tsconfig (`moduleResolution: bundler`, no `allowImportingTsExtensions`)
// a `.mts` import path fails typecheck with TS5097, while `.mjs` resolves to the
// `.mts` source for BOTH `tsc --noEmit` and `tsx` at runtime.
import { existsSync, writeFileSync, readFileSync, rmSync, appendFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pickNext } from "@/lib/foreman/queue";
import { plannerPrompt, parsePlannerPicks, isStandingDemotion, rankAndCapCandidates, PLAN_TARGET, PLANNER_MAX_CANDIDATES, type PlannerCandidate } from "@/lib/foreman/planner";
import { classifyRisk } from "@/lib/foreman/risk";
import { formatAudit, tailLog } from "@/lib/foreman/audit";
import { foremanPrompt, repairPrompt, resumePrompt, resumeContextPrompt, type TicketBrief } from "@/lib/foreman/prompt";
import { reviewerPrompt, parseReviewVerdict, type ReviewDiff } from "@/lib/foreman/review";
import { combineIntents, classifyInstruction } from "@/lib/foreman/intent";
import { decideApprove } from "@/lib/foreman/approve-decision";
import { nextVersion, extractTopChangelogEntry, prependChangelogEntry, conflictsAreMechanical, type BumpKind } from "@/lib/foreman/ship-rebase";
import { replyPrompt } from "@/lib/foreman/mention";
import { dedupGate, ledgerCandidates } from "@/lib/foreman/dedup-gate";
import { appendLedger, readLedger, type LedgerEntry } from "@/lib/foreman/ledger";
import { pendingGated } from "@/lib/foreman/reconcile";
import { buildRef, parseRef } from "@/lib/foreman/ref";
import { aggregateReadiness } from "@/lib/foreman/release-gate";
import { LEDGER_KIND_MAP, type InFlightBuild } from "@/lib/foreman/observe";
import type { Candidate } from "@/lib/foreman/dedup";
import { compareVersions } from "@/lib/changelog";
import * as db from "./db.mjs";
import { runAgent, NoForemanCredentialError, type AgentResult } from "./agent.mjs";
import { runChecks, diffSummary } from "./checks.mjs";
import * as ship from "./ship.mjs";
import { ensureWorkerDbs } from "./worker-db.mjs";
// Observability writers (Task 3). Imported with the `.mjs` specifier like every
// sibling module — under this tsconfig (`moduleResolution: bundler`) a `.mts`
// import path fails typecheck with TS5097; `.mjs` resolves to the `.mts` source.
import * as obs from "./observe.mjs";

const exec = promisify(execFile);

// Repo root, derived from THIS module's own location (scripts/foreman/run.mts →
// ../..), so the daemon runs from ANY clone path + user. Was hardcoded to the
// original host's /home/defcon/cosmos-v2, which broke a move to another host.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LEDGER = join(REPO, ".deploy/foreman-ledger.jsonl");
// DRY runs write here instead of the real ledger, so a dry preview never seeds an
// armed run's dedup/history. Reads in DRY consult BOTH (real + dry) — see processOne.
const LEDGER_DRY = join(REPO, ".deploy/foreman-ledger.dry.jsonl");
// Scratch cwd for the read-only dedup/clarity judges — NOT the live REPO, so a
// prompt-injected ticket routed through them can't touch the working checkout.
const SCRATCH = join(tmpdir(), "foreman-judge");
const STOP = join(REPO, ".deploy/FOREMAN_STOP");
const LOCK = join(REPO, ".deploy/FOREMAN_LOCK");
const LOG = "/var/log/cosmos-foreman.log";
const DRY = process.env.FOREMAN_DRY_RUN === "1";
// Bounded fix-forward: how many times a failing build is handed back to the SAME
// agent session (with the check output) before the ticket gates for a human.
const MAX_REPAIRS = 2;
// Parallel build SLOTS (builds concurrent; SHIP stays strictly serialized).
// The provisioned ceiling — the LIVE target within it comes from org settings
// (Settings → Feedback automation → Parallel builds) via db.deliveryWorkerTarget,
// re-read each pass so changes apply without a restart. DRY runs single-worker.
const MAX_SLOTS = DRY ? 1 : 3;

// Daemon's own package version, read once for the boot record. Best-effort: a
// missing/corrupt package.json must never stop the daemon from booting (the
// URL is anchored to this module, so it resolves regardless of cwd).
let pkgVersion = "unknown";
try {
  pkgVersion = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "unknown";
} catch {
  /* keep "unknown" — observability only, not load-bearing */
}

// Live registry of the builds worker slots are holding right now, mirrored into
// foreman_state.inFlight on every heartbeat. setPhase advances an entry through
// the pipeline; it's a no-op once the entry has been released (build finished).
const inFlightMeta = new Map<string, InFlightBuild>();
function setPhase(itemId: string, phase: InFlightBuild["phase"], extra?: { repairRound?: number }): void {
  const cur = inFlightMeta.get(itemId);
  if (cur) inFlightMeta.set(itemId, { ...cur, phase, ...(extra ?? {}) });
}

function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(line);
  try {
    appendFileSync(LOG, line);
  } catch {
    /* /var/log not writable (dev/CI) — stdout is the source of truth, so degrade quietly */
  }
}
const killed = (): boolean => existsSync(STOP);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Sleep that returns early once the kill file appears, so `touch FOREMAN_STOP`
 *  stops the daemon within ~1s instead of after a whole idle period. */
async function idleSleep(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !killed()) await sleep(Math.min(1000, end - Date.now()));
}

/** Semantic duplicate judge: one subscription `claude -p` over the shortlist. */
async function judge(
  title: string,
  shortlist: Candidate[],
  orgId: string,
): Promise<{ dupOf: string | null; reason: string }> {
  const list = shortlist.map((c) => `${c.ref}: ${c.title}`).join("\n");
  const prompt = `Ticket: "${title}". Already-known items:\n${list}\nIs the ticket the SAME underlying request as one of them? Reply exactly "DUP <ref>: <reason>" or "UNIQUE: <reason>".`;
  // Read-only tools + scratch cwd (not REPO): this judge reasons over untrusted
  // ticket/feedback text, so it must not be able to shell out or edit the repo. (I3)
  const r = await runAgent(SCRATCH, prompt, { orgId, maxTurns: 2, timeoutMs: 120_000, allowedTools: "Read,Grep,Glob" });
  // Honor the LAST verdict line, anchored to the line start: a hedged mid-sentence
  // "... this is NOT a DUP COSMOS-1 ..." can't register as a duplicate (it doesn't
  // start with "DUP "), and a trailing "UNIQUE:" overrides an earlier "DUP".
  // Parse failure (no verdict line at all) defaults to unique. (M1)
  let verdict: { dupOf: string | null; reason: string } = { dupOf: null, reason: "unique" };
  for (const raw of r.log.split("\n")) {
    const line = raw.trim();
    // Match any <KEY>-<n> ref (not just COSMOS — the pool spans every project any
    // org has opted in), then confirm it actually parses as a ref before trusting
    // it as a duplicate target; a shape match that still fails to parse (shouldn't
    // happen given the regex, but keeps this in lockstep with parseRef) is ignored
    // rather than treated as a verdict.
    const dup = line.match(/^DUP\s+(\S+-\d+)\s*:\s*(.*)$/);
    if (dup) {
      if (parseRef(dup[1]) !== null) {
        verdict = { dupOf: dup[1], reason: dup[2].trim() || "duplicate" };
      }
      continue;
    }
    if (/^UNIQUE\b/.test(line)) verdict = { dupOf: null, reason: line.replace(/^UNIQUE\s*:?\s*/, "").trim() || "unique" };
  }
  return verdict;
}

/** Clarity gate (§5.6): can this be built correctly without a product/scope
 *  decision the author must make? A cheap subscription judgment — never guess & ship. */
async function clarityCheck(brief: TicketBrief, orgId: string, instructions: string[] = []): Promise<{ needsInput: boolean; question: string }> {
  const criteria = brief.acceptanceCriteria[0]
    ? brief.acceptanceCriteria.map((c) => "- " + c).join("\n")
    : "(none)";
  const guidance = instructions.length
    ? `\nMaintainer instructions already provided in the ticket's comments (treat these as authoritative answers):\n${instructions.map((i) => "- " + i).join("\n")}\n`
    : "";
  const prompt = `A ticket to implement:\nTitle: ${brief.title}\nDescription: ${brief.description || "(none)"}\nAcceptance criteria:\n${criteria}\n${guidance}\nCan a competent engineer implement this CORRECTLY from what's written, WITHOUT a product/scope/UX/business decision that only the author can make (e.g. which metrics, what layout, a business rule, a missing credential, an ambiguous "which one")? Reply exactly "OK" if yes, or "NEEDS_INPUT: <the single most important question to unblock it>" if not.`;
  // Read-only tools + scratch cwd (not REPO): same untrusted-input reasoning as the
  // dedup judge — no shell, no repo writes. (I3)
  const r = await runAgent(SCRATCH, prompt, { orgId, maxTurns: 2, timeoutMs: 120_000, allowedTools: "Read,Grep,Glob" });
  const m = r.log.match(/NEEDS_INPUT:\s*(.+)/);
  return m ? { needsInput: true, question: m[1].trim() } : { needsInput: false, question: "" };
}

const PLANNER_TIMEOUT_MS = 120_000;
/** Keep To-do stocked to PLAN_TARGET: one cheap read-only LLM ranking pass over
 *  the eligible backlog, promoting the winners to To-do with a visible why.
 *  Skips any ticket under a standing human demotion (isStandingDemotion). Fully
 *  failure-isolated: any error logs and returns, so a planner hiccup can never
 *  throw into the pass loop or block a build. No writes in DRY. */
async function planPass(backlog: Awaited<ReturnType<typeof db.getBacklog>>): Promise<void> {
  try {
    const todoCount = backlog.filter((b) => b.columnKey === "todo").length;
    const slots = PLAN_TARGET - todoCount;
    if (slots <= 0) return;
    const pool = backlog.filter((b) => b.columnKey === "backlog");
    if (pool.length === 0) return;
    // The planner ranks the shared pool but runAgent must authenticate as ONE org's
    // Foreman subscription. Resolve the single Foreman-connected delivery org; with
    // none (or an ambiguous multiple) there's nothing to run the ranking on, so skip
    // the pass — the daemon idles the planner cleanly instead of throwing.
    const plannerOrgId = await db.primaryDeliveryOrgId();
    if (!plannerOrgId) {
      log(`planner: no Foreman-connected delivery org — skipping`);
      return;
    }
    const facts = await db.getDemotionFacts(pool.map((p) => p.id));
    const now = new Date();
    const eligible = pool.filter((p) => {
      const f = facts.get(p.id);
      if (!f) return true;
      return !isStandingDemotion({
        plannedAt: f.plannedAt,
        demotedAt: new Date(p.columnEnteredAt),
        updatedAt: f.updatedAt,
        lastCommentAt: f.lastCommentAt,
        now,
      });
    });
    if (eligible.length === 0) return;
    // Bound the digest: rank by priority then oldest-first (shared with pickNext)
    // and keep at most PLANNER_MAX_CANDIDATES, so a large backlog can't bloat the
    // prompt — the overflow dropped is always the lowest-priority, newest work.
    const ranked = rankAndCapCandidates(eligible, PLANNER_MAX_CANDIDATES);
    if (eligible.length > PLANNER_MAX_CANDIDATES) {
      log(`planner: digest capped at ${PLANNER_MAX_CANDIDATES} of ${eligible.length} candidates`);
    }
    const byKey = new Map(ranked.map((p) => [buildRef(p.projectKey, p.ticketNumber), p]));
    const candidates: PlannerCandidate[] = ranked.map((p) => ({
      key: buildRef(p.projectKey, p.ticketNumber),
      title: p.title,
      description: p.description ?? "",
      priority: p.priority,
      feedbackType: p.feedbackType,
      severity: p.severity,
      voteCount: p.voteCount,
      ageDays: Math.floor((now.getTime() - Date.parse(p.columnEnteredAt)) / 86_400_000),
    }));
    const r = await runAgent(SCRATCH, plannerPrompt(candidates, slots), {
      orgId: plannerOrgId,
      maxTurns: 2,
      timeoutMs: PLANNER_TIMEOUT_MS,
      allowedTools: "Read,Grep,Glob",
    });
    if (!r.ok) {
      log(`planner: agent failed — skipping this pass`);
      return;
    }
    const picks = parsePlannerPicks(r.log, new Set(byKey.keys()), slots);
    for (const pick of picks) {
      const item = byKey.get(pick.key);
      if (!item) continue;
      if (DRY) {
        log(`planner (dry): would promote ${pick.key} — ${pick.why}`);
        continue;
      }
      // Guarded promote: backlog → todo ONLY if still in backlog. A human who
      // moved the card during the ~120s LLM window (e.g. backlog → done) wins —
      // skip rather than resurrect it, and don't write the event or patch the row.
      const promoted = await db.promoteToTodo(item.id);
      if (!promoted) {
        log(`planner: ${pick.key} moved while planning — skipped`);
        continue;
      }
      // Keep this pass's in-memory view truthful for pickNext: the new column AND
      // a fresh columnEnteredAt matching what promoteToTodo just stamped, so the
      // FIFO tie-break agrees with the DB.
      item.columnKey = "todo";
      item.columnEnteredAt = new Date().toISOString();
      // The `planned` event is load-bearing — getDemotionFacts keys demotion
      // protection off it — so write it strictly. On failure the promotion still
      // stands (do NOT revert); only its demotion protection is degraded, so warn.
      try {
        await obs.trackStrict({
          workItemId: item.id,
          orgId: item.orgId,
          ticketKey: pick.key,
          kind: "planned",
          message: `Planned ${pick.key} → To-do: ${pick.why || "queued"}`,
          data: { why: pick.why },
        });
      } catch {
        log(`planner: WARN planned-event write failed for ${pick.key} — demotion protection degraded`);
      }
      log(`planner: ${pick.key} → todo — ${pick.why}`);
    }
  } catch (e) {
    log(`planner: pass failed — ${String(e)}`);
  }
}

/** Build a TicketBrief from its raw parts + the feedback-triage blob. Shared by
 *  briefFrom (backlog items) and the resume path (a review-column item, whose ref
 *  is already known and whose triage is fetched via db.triageFor). */
function briefFromParts(key: string, title: string, description: string, triage: unknown): TicketBrief {
  const tri = (triage ?? {}) as Record<string, unknown>;
  const classification: "BUG" | "FEATURE" = tri.classification === "FEATURE" ? "FEATURE" : "BUG";
  const rawCriteria = tri.acceptanceCriteria;
  return {
    key,
    title,
    description,
    classification,
    acceptanceCriteria: Array.isArray(rawCriteria)
      ? rawCriteria.filter((x: unknown): x is string => typeof x === "string")
      : [],
  };
}

function briefFrom(t: Awaited<ReturnType<typeof db.getBacklog>>[number]): TicketBrief {
  return briefFromParts(buildRef(t.projectKey, t.ticketNumber), t.title, t.description, t.triage);
}

/** One item's fresh @Foreman mention, as returned by db.freshMentions (Task 3). */
type FreshMention = Awaited<ReturnType<typeof db.freshMentions>>[number];

/** Queue of parked tickets whose owner replied with steering (the "instruct"
 *  intent) — drained into free build slots by the coordinator, BEFORE new backlog
 *  work, so a resume runs the maintainer's notes against the SAME session/worktree.
 *  Module-level (not local to main) so processMentions — which classifies the
 *  intent — can enqueue while the coordinator drains. Deduped by itemId: a second
 *  reply while one is queued/in-flight is a no-op (its text is already captured, or
 *  will be re-read next pass). */
const resumeQueue = new Map<string, { m: FreshMention; instructions: string[] }>();

/** Force the shared REPO checkout back to a pristine origin/main after a
 *  half-finished ship (a squash-merge conflict because main moved, a push that
 *  left local main ahead, or a throw mid-sequence). Every step is best-effort and
 *  independent, so a no-op on one (e.g. "there is no merge to abort") never blocks
 *  the rest — the invariant is only that we end on a clean main tracking origin. */
async function restoreMain(): Promise<void> {
  await exec("git", ["-C", REPO, "merge", "--abort"]).catch(() => undefined);
  await exec("git", ["-C", REPO, "checkout", "-f", "main"]).catch(() => undefined);
  await exec("git", ["-C", REPO, "reset", "--hard"]).catch(() => undefined);
  await exec("git", ["-C", REPO, "fetch", "origin", "main"]).catch(() => undefined);
  await exec("git", ["-C", REPO, "reset", "--hard", "origin/main"]).catch(() => undefined);
}

interface Built {
  itemId: string;
  key: string;
  title: string;
  classification: "BUG" | "FEATURE";
  branch: string;
  wt: string;
  sessionId: string | undefined;
  subject: string;
  commit: string;
  processNote: string;
  changelogEntry: string | null;
  bumpKind: BumpKind;
  // Set ONLY on a resume handoff (processResume): the existing parked draft PR to
  // ship in place. When present, shipBuilt reuses it (marks it ready + merges)
  // instead of opening a fresh PR — the resume already updated it via git push.
  // Undefined for every fresh build (processOne), which opens its own PR.
  prUrl?: string;
}

/** Bounded fix-forward repair loop, shared by processOne and processResume: run
 *  the checks and, while failing and under MAX_REPAIRS, resume the SAME agent
 *  session with the failing output so it fixes forward in place. Returns the final
 *  checks result + repair count; `halted:true` means the kill switch fired
 *  mid-loop and the caller must abandon WITHOUT shipping. Phase-advance is left to
 *  the caller (via `onRound`) so each keeps its own inFlightMeta wiring. */
async function repairLoop(
  key: string,
  orgId: string,
  wt: string,
  sessionId: string | undefined,
  testDbUrl: string | undefined,
  haltIfKilled: () => Promise<boolean>,
  onRound: (round: number) => void,
): Promise<{ checks: Awaited<ReturnType<typeof runChecks>>; repairs: number; halted: boolean }> {
  let checks = await runChecks(wt, { testDbUrl });
  let repairs = 0;
  while (!checks.ok && repairs < MAX_REPAIRS) {
    if (await haltIfKilled()) return { checks, repairs, halted: true };
    repairs++;
    log(`${key} checks failed — repair round ${repairs}/${MAX_REPAIRS}`);
    onRound(repairs);
    const rep = await runAgent(wt, repairPrompt(key, tailLog(checks.log, 3000)), {
      orgId,
      resume: sessionId,
      timeoutMs: 25 * 60_000,
      testDbUrl,
    });
    if (!rep.ok) {
      log(`${key} repair agent did not complete — gating with the last check output`);
      break;
    }
    checks = await runChecks(wt, { testDbUrl });
  }
  return { checks, repairs, halted: false };
}

/** Adversarial, READ-ONLY pre-ship review of the final diff (origin/main...HEAD),
 *  shared by processOne and processResume. The diff is inlined for the normal case
 *  (SAFE ⇒ small) and, when oversized, written INSIDE the resolved git dir — never
 *  the worktree, so it can't enter the change under review (in a linked worktree
 *  `.git` is a FILE, so the path is resolved via rev-parse). Fail-closed: an
 *  unreadable/failed reviewer yields {approve:false}; one retry absorbs infra flakes. */
async function reviewFinalDiff(brief: TicketBrief, orgId: string, wt: string): Promise<{ approve: boolean; reason: string }> {
  const { stdout: diffText } = await exec("git", ["-C", wt, "diff", "origin/main...HEAD"], {
    maxBuffer: 32 * 1024 * 1024,
  });
  let reviewDiff: ReviewDiff;
  if (diffText.length <= 200_000) {
    reviewDiff = { kind: "inline", text: diffText };
  } else {
    const { stdout: gitDir } = await exec("git", ["-C", wt, "rev-parse", "--absolute-git-dir"]);
    const diffFile = join(gitDir.trim(), "FOREMAN_REVIEW.diff");
    writeFileSync(diffFile, diffText);
    reviewDiff = { kind: "file", path: diffFile };
  }
  const reviewOpts = { orgId, allowedTools: "Read,Grep,Glob", maxTurns: 30, timeoutMs: 15 * 60_000 };
  let review = await runAgent(wt, reviewerPrompt(brief, reviewDiff), reviewOpts);
  if (!review.ok) review = await runAgent(wt, reviewerPrompt(brief, reviewDiff), reviewOpts);
  return review.ok
    ? parseReviewVerdict(review.log)
    : { approve: false, reason: "reviewer agent failed twice (infra)" };
}

async function processOne(
  item: Awaited<ReturnType<typeof db.getBacklog>>[number],
  workerOpts: { testDbUrl?: string } = {},
): Promise<{ ship?: Built }> {
  const brief = briefFrom(item);
  const key = brief.key;
  // DRY records to the .dry ledger so a preview never pollutes the real history
  // (which would seed the next armed run's dedup). (I5)
  const record = (e: Omit<LedgerEntry, "ts">): void => {
    appendLedger(DRY ? LEDGER_DRY : LEDGER, { ...e, ts: new Date().toISOString() });
    // Every durable outcome also lands in the live event feed (best-effort, never
    // awaited — obs.track swallows its own errors). Suppressed in DRY, exactly
    // like the terminal board writes, so a preview never seeds the real feed.
    if (!DRY)
      void obs.track({
        workItemId: item.id,
        ticketKey: e.ticket,
        kind: LEDGER_KIND_MAP[e.resolution] ?? "error",
        severity: e.resolution === "gated" ? "warn" : "info",
        message: `${e.ticket} ${e.resolution}${e.version ? ` v${e.version}` : ""}${e.dupOf ? ` (dup of ${e.dupOf})` : ""}`,
        data: { version: e.version, dupOf: e.dupOf },
      });
  };

  // Dedup gate FIRST — don't spin a worktree for something already known. In DRY,
  // read the real ledger AND the .dry ledger (so a preview dedups against real
  // ships plus its own earlier same-survey "would-ship" entries). Exclude this
  // ticket's OWN ref from every candidate source — a ticket must never dedup
  // against itself. (I5 + self-dedup)
  const ledgerEntries = readLedger(LEDGER);
  if (DRY) ledgerEntries.push(...readLedger(LEDGER_DRY));
  const candidates = [
    ...ledgerCandidates(ledgerEntries),
    ...(await db.historyCandidates()),
  ].filter((c) => c.ref !== key);
  // A decomposition child (parent_id set) must never dedup against its own parent
  // epic or a sibling child of that epic — those are intentionally overlapping
  // scopes, not duplicates (COSMOS-123). The gate excludes them via parentRef.
  const dup = await dedupGate(
    { title: brief.title, candidates, parentRef: item.parentRef },
    (title, shortlist) => judge(title, shortlist, item.orgId),
  );
  if (dup.dupOf) {
    log(`${key} duplicate of ${dup.dupOf} — ${dup.reason}`);
    if (!DRY) {
      await db.moveColumn(item.id, "done");
      await db.addTag(item.id, "duplicate");
      await db.comment(item.id, `Resolved as duplicate of ${dup.dupOf}. ${dup.reason}`);
    }
    record({ ticket: key, title: brief.title, classification: brief.classification, resolution: "duplicate", dupOf: dup.dupOf });
    return {};
  }

  // Clarity gate — does this need a product/scope decision Foreman can't make? (§5.6)
  // @Foreman instructions from privileged ticket comments — authoritative
  // answers/steering for both the clarity gate and the build itself.
  const instructions = await db.instructionsFor(item.id).catch(() => [] as string[]);
  const clar = await clarityCheck(brief, item.orgId, instructions);
  if (clar.needsInput) {
    log(`${key} needs input — ${clar.question}`);
    if (!DRY) {
      await db.moveColumn(item.id, "review");
      await db.addTag(item.id, "needs-input");
      await db.comment(item.id, `❓ Needs your input before I can build this: ${clar.question}\n\nAnswer in the description/comments and reply here to instruct or say 'rebuild' to re-queue.`);
      await db.notifyDelivery(item.id, "parked", { key, title: brief.title, reason: `needs input — ${clar.question}` });
      await obs.track({ workItemId: item.id, ticketKey: key, kind: "parked", severity: "warn", message: `needs input — ${clar.question}`, data: { reason: clar.question } });
    }
    record({ ticket: key, title: brief.title, classification: brief.classification, resolution: "needs-input" });
    return {};
  }

  // Claimed atomically by the coordinator (db.claimTicket) before dispatch.
  const branch = `auto/${key}`;
  const wt = `/tmp/foreman/${key}`;
  let keepWorktree = false; // set when the build hands off to the ship worker
  // Force-clean any leftover worktree dir from a prior crashed/raced pass — `worktree
  // add` fails hard on "'<dir>' already exists", which strands the ticket in-progress.
  rmSync(wt, { recursive: true, force: true });
  await exec("git", ["-C", REPO, "worktree", "prune"]).catch(() => undefined);
  await exec("git", ["-C", REPO, "fetch", "origin", "main"]);
  await exec("git", ["-C", REPO, "worktree", "add", "-B", branch, wt, "origin/main"]);
  // A worktree checks out only tracked files — node_modules is gitignored, so it's
  // absent, and `npx tsc/eslint/vitest` in checks.mts (and the agent's own
  // self-verification) would resolve to a stray global stub and fail EVERY ticket,
  // gating everything. Symlink the shared install so checks run against the real
  // dependency tree (incl. the generated .prisma client). It's gitignored so it
  // never rides into a commit or the changed-files diff; worktree remove/prune only
  // unlink the symlink, never its target. A ticket that changes package.json deps
  // would fail against this stale tree → gates for review, the safe direction.
  try {
    symlinkSync(join(REPO, "node_modules"), join(wt, "node_modules"), "dir");
  } catch (e) {
    log(`${key} node_modules symlink failed (checks may gate): ${String(e)}`);
  }
  // Kill-switch checkpoints: once the branch/worktree exists, a `touch FOREMAN_STOP`
  // mid-build must NOT merge+deploy. At each checkpoint below, if killed we abandon
  // WITHOUT shipping — leave the ticket in-progress with a note, restore the shared
  // checkout to main, and let the `finally` prune the worktree. `killed()` is the
  // same module-scope check main()'s loop uses, so processOne sees it directly. (I1)
  const haltIfKilled = async (): Promise<boolean> => {
    if (!killed()) return false;
    log(`${key} halted by kill switch — left in progress`);
    if (!DRY) {
      await db
        .comment(item.id, "Halted by kill switch mid-build; left in progress. Move the card back to Backlog to retry.")
        .catch(() => undefined);
      await restoreMain();
    }
    return true;
  };
  try {
    const agent = await runAgent(wt, foremanPrompt(brief, instructions), { orgId: item.orgId, testDbUrl: workerOpts.testDbUrl });
    if (await haltIfKilled()) return {}; // checkpoint 1: right after the agent returns

    // (a) Agent infra-failure (timeout, spawn error, or non-zero exit → agent.ok
    //     false, usually with no commit). Gate for review — NEVER conflate this
    //     with "already done" and auto-close a build that actually failed. (I2)
    if (!agent.ok) {
      log(`${key} GATED (agent did not complete) → In Review`);
      if (!DRY) {
        await db.moveColumn(item.id, "review");
        await db.comment(item.id, `Needs review — agent did not complete (timeout, spawn error, or non-zero exit); no automated build produced. Last output:\n\n${agent.log.slice(-1000).trim() || "(no output)"}`);
        await db.notifyDelivery(item.id, "parked", { key, title: brief.title, reason: "agent did not complete" });
        await obs.track({ workItemId: item.id, ticketKey: key, kind: "parked", severity: "warn", message: "agent did not complete", data: { reason: "agent did not complete", sessionId: agent.sessionId ?? undefined } });
      }
      record({ ticket: key, title: brief.title, classification: brief.classification, resolution: "gated" });
      return {};
    }

    // (b) Agent completed. A truly empty diff means it was already implemented —
    //     regardless of checks — so there's nothing to build OR ship. This also
    //     stops an empty diff from falling through to mergeBranch's
    //     `commit --no-edit`, which would fail on nothing-to-commit. (I2)
    let diff = await diffSummary(wt);
    if (diff.files.length === 0) {
      log(`${key} already implemented (empty diff)`);
      if (!DRY) {
        await db.moveColumn(item.id, "done");
        await db.addTag(item.id, "already-done");
        await db.comment(item.id, "Already implemented — no change produced.");
      }
      record({ ticket: key, title: brief.title, classification: brief.classification, resolution: "already-done" });
      return {};
    }

    // (c) Real change → checks with a bounded REPAIR LOOP. A first-pass check
    // failure no longer parks the ticket outright: the SAME agent session is
    // resumed (full context of what it built) with the failing output and told to
    // fix forward — up to MAX_REPAIRS rounds, then gate. This targets the observed
    // failure mode where a good change's own new test needed one more iteration.
    setPhase(item.id, "checks");
    const repair = await repairLoop(
      key,
      item.orgId,
      wt,
      agent.sessionId ?? undefined,
      workerOpts.testDbUrl,
      haltIfKilled,
      (round) => setPhase(item.id, "repair", { repairRound: round }),
    );
    if (repair.halted) return {}; // kill switch fired mid-repair — abandon without shipping
    const { checks, repairs } = repair;
    // Recompute the diff after repairs (rounds may add/change files) — the risk
    // classifier and the migration flag must see the FINAL change, not round 0's.
    diff = await diffSummary(wt);
    // Capture the build's audit identity AFTER repairs — version the agent bumped
    // to, HEAD commit + subject — so gate and ship paths record what will actually
    // merge. readVersion JSON-parses package.json; a build that corrupted it should
    // still gate on checks, not crash the loop — tolerate and leave version "".
    let version = "";
    try {
      version = ship.readVersion(wt);
    } catch {
      /* corrupt package.json → checks fail → gate */
    }
    const { commit, subject } = await ship.headInfo(wt);
    const risk = classifyRisk(diff);
    const processParts: string[] = [];
    if (repairs > 0) processParts.push(`${repairs} repair round${repairs > 1 ? "s" : ""}`);

    /** Park the built branch for human review as a draft PR + audit comment —
     *  shared by the checks/risk gate and the reviewer gate below. */
    const parkForReview = async (reason: string, checkLog?: string): Promise<void> => {
      log(`${key} GATED (${reason}) → In Review`);
      // Hoisted so the park EVENT (and the owner notification) can carry the draft
      // PR url — the approval loop's approve/resume paths read parked.prUrl to know
      // there's a PR to merge (freshMentions → decideApprove). Undefined in DRY.
      let prUrl: string | undefined;
      if (!DRY) {
        await ship.pushBranch(branch);
        // ensurePr, not openPr: on a REBUILD the branch is reused and the prior
        // park's PR may still be OPEN — a bare `gh pr create` throws ("a pull
        // request for branch … already exists") and leaves the card stuck
        // in-progress. ensurePr updates the existing PR instead when one exists.
        prUrl = await ship.ensurePr(
          branch,
          `auto: ${key} (review — ${reason})`.slice(0, 250),
          `Automated draft for ${key}. Reason parked: ${reason}. Approve = merge; Foreman deploys it on its next pass.`,
          true,
        );
        await db.moveColumn(item.id, "review");
        await db.comment(
          item.id,
          formatAudit({
            key,
            outcome: "review",
            summary: subject,
            reason,
            version,
            branch,
            prUrl,
            commit,
            checkLog,
            process: processParts.length ? processParts.join(" · ") : undefined,
          }),
        );
      }
      record({ ticket: key, title: brief.title, classification: brief.classification, resolution: "gated" });
      if (!DRY) await db.notifyDelivery(item.id, "parked", { key, title: brief.title, reason, version, prUrl });
      if (!DRY) await obs.track({ workItemId: item.id, ticketKey: key, kind: "parked", severity: "warn", message: reason, data: { reason, version, sessionId: agent.sessionId ?? undefined, branch, worktreePath: wt, prUrl } });
    };

    if (!checks.ok || risk.gated) {
      // Include the failing check output only when checks are the reason — a
      // risk-gate (checks green, touched a sensitive path / too big) has none.
      await parkForReview(!checks.ok ? "checks failed" : risk.reasons.join("; "), checks.ok ? undefined : checks.log);
      return {};
    }

    // (d) Pre-ship REVIEW: checks are green and risk says safe, so this change
    // would auto-merge to prod — an adversarial, READ-ONLY second agent judges the
    // final diff first (risky changes already get a human; this covers the safe
    // path). Fail-closed inside reviewFinalDiff: an unreadable/failed reviewer
    // returns {approve:false} → parked, because a ship gate that can't run must
    // not open. Same helper the resume path uses.
    setPhase(item.id, "review");
    const verdict = await reviewFinalDiff(brief, item.orgId, wt);
    if (!verdict.approve) {
      await parkForReview(`reviewer rejected — ${verdict.reason}`);
      return {};
    }
    processParts.push(`reviewer approved — ${verdict.reason}`);
    const processNote = processParts.join(" · ");

    // ── Coordinated-release gate (COSMOS-118) ────────────────────────────────
    // If this ticket is a phase child of an epic marked "coordinated", it must NOT
    // ship on its own — that IS the bug this gate prevents (an epic going out as N
    // separate version patches). Hold it here: green+approved but parked, with the
    // epic's aggregate readiness surfaced (never a silent half-release). The batched
    // single-version release (merge siblings in dependency order, one tag/deploy)
    // runs via COSMOS-115's decomposition executor once every sibling is ready.
    // Non-epic tickets and "incremental" epics have no coordinated parent, so they
    // fall straight through to the ship handoff below and ship per-ticket (AC2).
    const coord = await db.epicCoordination(item.id).catch(() => null);
    if (coord && coord.mode === "coordinated") {
      const summary = aggregateReadiness(coord.mode, coord.siblings);
      await parkForReview(`held for coordinated release of ${coord.epicKey ?? "its epic"} — ${summary.label}`);
      return {};
    }

    // SAFE → hand off to the serialized SHIP worker. The agent bumped from the
    // main it branched off; ship re-bumps after rebasing onto CURRENT main.
    log(`${key} SAFE → queued for ship (built v${version})${DRY ? " (DRY)" : ""}`);
    setPhase(item.id, "queued-ship");
    // Suppressed in DRY — the next line returns instead of actually queuing, so a
    // preview must not emit a ship-path event for work it never hands off.
    if (!DRY) await obs.track({ workItemId: item.id, ticketKey: key, kind: "queued-ship", message: `SAFE → queued for ship (built v${version})` });
    if (DRY) {
      record({ ticket: key, title: brief.title, classification: brief.classification, resolution: "shipped", version });
      return {};
    }

    if (await haltIfKilled()) return {}; // checkpoint 2: before entering the ship queue

    // Capture the build's changelog entry (if it added one) so the ship worker
    // can re-prepend it with the corrected version after the rebase.
    let changelogEntry: string | null = null;
    if (diff.files.includes("src/lib/changelog.ts")) {
      try {
        const cl = readFileSync(join(wt, "src/lib/changelog.ts"), "utf8");
        changelogEntry = extractTopChangelogEntry(cl)?.entry ?? null;
      } catch {
        /* unreadable changelog → ship without an entry rewrite */
      }
    }
    keepWorktree = true; // the ship worker owns cleanup from here
    return {
      ship: {
        itemId: item.id,
        key,
        title: brief.title,
        classification: brief.classification,
        branch,
        wt,
        sessionId: agent.sessionId ?? undefined,
        subject,
        commit,
        processNote,
        changelogEntry,
        bumpKind: brief.classification === "FEATURE" ? "minor" : "patch",
      },
    };

  } finally {
    if (!keepWorktree) await exec("git", ["-C", REPO, "worktree", "remove", "--force", wt]).catch(() => undefined);
    // Armed-only last-resort: never leave the shared checkout on a foreign or
    // dirty branch after a ship, whatever escaped above. DRY never moves REPO off
    // main (it returns before mergeBranch), so skip the force-checkout there to
    // keep dry-runs side-effect-free on the working checkout.
    if (!DRY) await exec("git", ["-C", REPO, "checkout", "-f", "main"]).catch(() => undefined);
  }
}

/** SHIP worker — strictly serialized (one at a time via the coordinator's
 *  promise chain). Takes a BUILT, checks-green, reviewer-approved branch and:
 *  rebases it onto CURRENT main (mechanically resolving the version-race trio:
 *  package.json / package-lock.json / changelog — re-bumping to the next
 *  version after main and re-prepending the build's changelog entry), smoke
 *  typechecks, then runs the PR→merge→tag→image→deploy pipeline with the tag
 *  GUARDED (a pre-existing tag parks instead of deploying someone else's
 *  image — the v2.174.0 lesson). Returns deployFailed for the breaker. */
async function shipBuilt(b: Built): Promise<{ deployFailed: boolean }> {
  setPhase(b.itemId, "shipping");
  const record = (e: Omit<LedgerEntry, "ts">): void => {
    appendLedger(LEDGER, { ...e, ts: new Date().toISOString() });
    // Mirror processOne: every ship outcome also lands in the live event feed.
    if (!DRY)
      void obs.track({
        workItemId: b.itemId,
        ticketKey: e.ticket,
        kind: LEDGER_KIND_MAP[e.resolution] ?? "error",
        severity: e.resolution === "gated" ? "warn" : "info",
        message: `${e.ticket} ${e.resolution}${e.version ? ` v${e.version}` : ""}${e.dupOf ? ` (dup of ${e.dupOf})` : ""}`,
        data: { version: e.version, dupOf: e.dupOf },
      });
  };
  const parkShip = async (reason: string): Promise<void> => {
    log(`${b.key} SHIP PARKED (${reason}) → In Review`);
    await ship.pushBranch(b.branch).catch(() => undefined);
    let prUrl = "";
    try {
      // ensurePr updates an already-open PR (from the build phase or a prior
      // park) instead of failing on a duplicate create — so the parked card
      // still records a url for Approve to merge, rather than silently losing it.
      prUrl = await ship.ensurePr(
        b.branch,
        `auto: ${b.key} (review — ${reason})`.slice(0, 250),
        `Automated draft for ${b.key}. Reason parked: ${reason}. Approve = merge; Foreman deploys it on its next pass.`,
        true,
      );
    } catch {
      /* PR upsert failed (gh/network) — park anyway; reconcile/approve can recover */
    }
    await db.moveColumn(b.itemId, "review");
    await db.comment(
      b.itemId,
      formatAudit({ key: b.key, outcome: "review", summary: b.subject, reason, branch: b.branch, commit: b.commit, prUrl: prUrl || undefined, process: b.processNote }),
    );
    record({ ticket: b.key, title: b.title, classification: b.classification, resolution: "gated" });
    await db.notifyDelivery(b.itemId, "parked", { key: b.key, title: b.title, reason, prUrl: prUrl || undefined });
    await obs.track({ workItemId: b.itemId, ticketKey: b.key, kind: "parked", severity: "warn", message: reason, data: { reason, prUrl: prUrl || undefined, sessionId: b.sessionId, branch: b.branch } });
  };

  try {
    if (killed()) {
      log(`${b.key} ship halted by kill switch — left in progress`);
      await db.comment(b.itemId, "Halted by kill switch before ship; left in progress. Move the card back to Backlog to retry.").catch(() => undefined);
      return { deployFailed: false };
    }

    // ── Rebase onto CURRENT main; resolve the version-race trio mechanically ──
    await exec("git", ["-C", b.wt, "fetch", "origin", "main"]);
    let rebased = true;
    try {
      await exec("git", ["-C", b.wt, "rebase", "origin/main"]);
    } catch {
      rebased = false;
    }
    if (!rebased) {
      const { stdout } = await exec("git", ["-C", b.wt, "diff", "--name-only", "--diff-filter=U"]);
      const conflicted = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!conflictsAreMechanical(conflicted)) {
        await exec("git", ["-C", b.wt, "rebase", "--abort"]).catch(() => undefined);
        await parkShip(`rebase conflict with main (${conflicted.join(", ") || "unknown files"})`);
        return { deployFailed: false };
      }
      // Take MAIN's copies ("ours" during a rebase), then re-apply the bump + entry.
      await exec("git", ["-C", b.wt, "checkout", "--ours", "--", ...conflicted]);
      const mainVersion = ship.readVersion(b.wt);
      const newVersion = nextVersion(mainVersion, b.bumpKind);
      await exec("npm", ["version", newVersion, "--no-git-tag-version"], { cwd: b.wt });
      if (b.changelogEntry) {
        const clPath = join(b.wt, "src/lib/changelog.ts");
        const cl = readFileSync(clPath, "utf8");
        writeFileSync(clPath, prependChangelogEntry(cl, b.changelogEntry, newVersion));
      }
      await exec("git", ["-C", b.wt, "add", "--", ...conflicted]);
      await exec("git", ["-C", b.wt, "rebase", "--continue"], {
        env: { ...process.env, GIT_EDITOR: "true" },
      });
    }

    // Post-rebase sanity: fast typecheck (full checks already passed pre-rebase;
    // mechanical version-file resolution can't change runtime semantics, but a
    // REAL rebase onto moved code can — tsc is the cheap tripwire).
    try {
      await exec("npx", ["tsc", "--noEmit"], { cwd: b.wt, maxBuffer: 32 * 1024 * 1024 });
    } catch {
      await parkShip("post-rebase typecheck failed (main moved under the build)");
      return { deployFailed: false };
    }

    const version = ship.readVersion(b.wt);
    const { commit } = await ship.headInfo(b.wt);
    const finalDiff = await diffSummary(b.wt);
    log(`${b.key} SHIP → v${version}`);

    let prUrl = b.prUrl ?? "";
    let merged = false;
    let mergedCommit = "";
    try {
      await ship.pushBranch(b.branch);
      // A RESUME handoff (b.prUrl set) already has an open draft PR on this branch —
      // pushBranch above just updated it in place, so reuse it and mark it ready so
      // the squash-merge can land, instead of opening a second PR (gh refuses a
      // duplicate). A FRESH build has no PR yet → open a non-draft one to auto-merge.
      if (b.prUrl) {
        await exec("gh", ["pr", "ready", b.branch], { cwd: REPO }).catch(() => undefined);
      } else {
        prUrl = await ship.openPr(
          b.branch,
          `auto: ${b.key} — ${b.title}`.slice(0, 250),
          `Automated fix for ${b.key} (v${version}). Auto-merged by Foreman after green checks.`,
          false,
        );
      }
      await ship.mergePr(b.branch);
      merged = true;
      mergedCommit = (await ship.headInfo(REPO)).commit;
      // TAG GUARD: a pre-existing tag means someone else claimed this version —
      // deploying it would ship THEIR image under our number (v2.174.0 lesson).
      let tagExists = true;
      try {
        await exec("git", ["-C", REPO, "rev-parse", `v${version}`]);
      } catch {
        tagExists = false;
      }
      if (tagExists) throw new Error(`tag v${version} already exists — version collision`);
      await ship.tagAndPush(version);
      if (!(await ship.waitForImage(version))) throw new Error("image build failed");
    } catch (e) {
      log(`${b.key} ship failed ${merged ? "after merge (merged, undeployed)" : "before merge"} (${String(e)}) → In Review`);
      await restoreMain();
      await db.moveColumn(b.itemId, "review");
      await db.comment(
        b.itemId,
        merged
          ? formatAudit({ key: b.key, outcome: "merged-undeployed", summary: b.subject, process: b.processNote, reason: String(e), version, branch: b.branch, prUrl: prUrl || undefined, commit: mergedCommit || commit })
          : formatAudit({ key: b.key, outcome: "ship-failed", summary: b.subject, process: b.processNote, reason: `${String(e)}; restored main`, version, branch: b.branch, prUrl: prUrl || undefined, commit }),
      );
      record({ ticket: b.key, title: b.title, classification: b.classification, resolution: "gated" });
      await db.notifyDelivery(b.itemId, "parked", { key: b.key, title: b.title, reason: merged ? "merged but not deployed" : "ship failed before merge", version, prUrl: prUrl || undefined });
      await obs.track({ workItemId: b.itemId, ticketKey: b.key, kind: merged ? "merged-undeployed" : "ship-failed", severity: "error", message: merged ? `merged but not deployed (v${version})` : "ship failed before merge", data: { version, prUrl: prUrl || undefined, merged, sessionId: b.sessionId, branch: b.branch } });
      return { deployFailed: false };
    }

    if (killed()) {
      log(`${b.key} halted by kill switch before deploy — merged, undeployed; reconcile finishes it`);
      return { deployFailed: false };
    }

    const rollbackTo = await ship.currentProdVersion();
    const ok = await ship.deploy(version, finalDiff.files.some((f) => f.startsWith("prisma/migrations/")));
    if (ok) {
      await db.moveColumn(b.itemId, "done");
      await db.comment(
        b.itemId,
        formatAudit({ key: b.key, outcome: "shipped", summary: b.subject, process: b.processNote, version, rollbackTo, branch: b.branch, prUrl: prUrl || undefined, commit: mergedCommit || commit }),
      );
      record({ ticket: b.key, title: b.title, classification: b.classification, resolution: "shipped", version });
      await db.notifyDelivery(b.itemId, "shipped", { key: b.key, title: b.title, version, prUrl: prUrl || undefined });
      log(`${b.key} DONE v${version}`);
      return { deployFailed: false };
    }
    try {
      await ship.rollback(version);
      await db.moveColumn(b.itemId, "review");
      await db.comment(
        b.itemId,
        formatAudit({ key: b.key, outcome: "rolled-back", summary: b.subject, process: b.processNote, reason: "deploy health-gate failed", version, rollbackTo, branch: b.branch, prUrl: prUrl || undefined, commit: mergedCommit || commit }),
      );
      record({ ticket: b.key, title: b.title, classification: b.classification, resolution: "gated" });
      await db.notifyDelivery(b.itemId, "parked", { key: b.key, title: b.title, reason: "deploy health-gate failed; rolled back", version, prUrl: prUrl || undefined });
      await obs.track({ workItemId: b.itemId, ticketKey: b.key, kind: "parked", severity: "error", message: "deploy health-gate failed; rolled back", data: { reason: "deploy health-gate failed; rolled back", version, prUrl: prUrl || undefined, sessionId: b.sessionId, branch: b.branch } });
    } catch (cleanupErr) {
      log(`${b.key} deploy-gate cleanup error (continuing to circuit breaker): ${String(cleanupErr)}`);
    }
    return { deployFailed: true };
  } finally {
    await exec("git", ["-C", REPO, "worktree", "remove", "--force", b.wt]).catch(() => undefined);
    await exec("git", ["-C", REPO, "checkout", "-f", "main"]).catch(() => undefined);
  }
}

/** Is the PR at `prRef` (a URL / branch / number gh accepts) already merged?
 *  Best-effort — any gh error (no PR, transient failure) is treated as NOT merged,
 *  which routes an approve to the merge path and lets mergePr's own error surface
 *  the real problem (conflict guidance) rather than silently doing nothing. */
async function prIsMerged(prRef: string): Promise<boolean> {
  try {
    const { stdout } = await exec("gh", ["pr", "view", prRef, "--json", "state,mergedAt"], { cwd: REPO });
    return (JSON.parse(stdout) as { state?: string }).state === "MERGED";
  } catch {
    return false;
  }
}

/** The comment posted when an approve→merge fails — almost always the parked
 *  branch no longer applies to a main that moved since it was built. Names the two
 *  levers: rebuild (regenerate from current main) or resolve by hand on the branch. */
function mergeConflictGuidance(key: string, branch: string, err: string): string {
  return `I couldn't merge ${key} — the parked branch no longer applies cleanly to main (it moved since this was built).

Details: ${err}

Two ways forward:
- Reply "rebuild" (or "start over") and I'll regenerate the change against current main, then re-park it for your approval.
- Or resolve it by hand: rebase \`${branch}\` onto \`origin/main\`, push, and merge the PR — my next reconcile pass will deploy it.`;
}

/** A REPO-mutating unit of work, appended to the coordinator's serialized ship
 *  chain and settled on its own — see `enqueueRepoWork` in main(). Lets a
 *  caller outside the chain (handleApprove) still react to what ITS OWN
 *  enqueued work did, while the chain link itself never breaks the queue for
 *  whatever runs next. */
type EnqueueRepoWork = <T>(work: () => Promise<T>) => Promise<T>;

/** Auto-heal an approve→merge that failed because the PARKED branch drifted from
 *  main — the usual cause when an epic's later sibling phases are approved after
 *  an earlier one already shipped. Applies the SAME mechanical rebase-and-re-bump
 *  the queued-ship worker (`shipBuilt`) uses: rebase the branch onto current main
 *  in a throwaway worktree, and if the ONLY conflicts are the version-race trio
 *  (package.json / package-lock.json / changelog) take main's copies, assign a
 *  version strictly above main (so it actually deploys instead of reading
 *  "already live"), typecheck, and force-push the rebased branch so the retry
 *  merge lands. A REAL code conflict aborts → { ok:false } and the caller parks
 *  with the usual conflict guidance, exactly as before. MUST run inside the
 *  ship-chain mutex (the caller wraps it) so its worktree/push can't race a
 *  build's own merge on the shared .git. */
async function autoRebaseParkedBranch(branch: string): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
  const ref = branch.replace(/^origin\//, "");
  const wt = join(tmpdir(), `approve-rebase-${ref.replace(/[^a-zA-Z0-9]+/g, "-")}`);
  await exec("git", ["-C", REPO, "worktree", "remove", "--force", wt]).catch(() => undefined);
  await exec("git", ["-C", REPO, "fetch", "origin", "main", ref]);
  await exec("git", ["-C", REPO, "worktree", "add", "--force", wt, `origin/${ref}`]);
  try {
    try {
      await exec("git", ["-C", wt, "rebase", "origin/main"]);
    } catch {
      const conflicted = (await exec("git", ["-C", wt, "diff", "--name-only", "--diff-filter=U"]))
        .stdout.split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (!conflictsAreMechanical(conflicted)) {
        await exec("git", ["-C", wt, "rebase", "--abort"]).catch(() => undefined);
        return { ok: false, reason: `rebase conflict with main (${conflicted.join(", ") || "unknown files"})` };
      }
      // "ours" during a rebase is main (the base we replay onto) — take its copies
      // of the version-race trio, then re-bump below so the number stays monotonic.
      await exec("git", ["-C", wt, "checkout", "--ours", "--", ...conflicted]);
      await exec("git", ["-C", wt, "add", "--", ...conflicted]);
      await exec("git", ["-C", wt, "rebase", "--continue"], { env: { ...process.env, GIT_EDITOR: "true" } });
    }
    // Assign a version strictly above main so the approved change actually ships
    // (a stale/equal version merges but reads "already live" and never deploys —
    // the COSMOS-123 symptom). nextVersion off MAIN, not the branch's stale bump.
    const mainVer = (JSON.parse((await exec("git", ["-C", REPO, "show", "origin/main:package.json"])).stdout) as { version: string }).version;
    const target = nextVersion(mainVer, "patch");
    if (ship.readVersion(wt) !== target) {
      await exec("npm", ["version", target, "--no-git-tag-version"], { cwd: wt });
      await exec("git", ["-C", wt, "commit", "-aqm", `chore(release): rebase ${ref} onto main → v${target}`]).catch(() => undefined);
    }
    // Tripwire: mechanical version resolution can't change semantics, but a real
    // rebase onto moved code can — tsc is the cheap catch before publish + merge.
    await exec("npx", ["tsc", "--noEmit"], { cwd: wt, maxBuffer: 32 * 1024 * 1024 });
    await exec("git", ["-C", wt, "push", "--force-with-lease", "origin", `HEAD:${ref}`]);
    return { ok: true, version: ship.readVersion(wt) };
  } finally {
    await exec("git", ["-C", REPO, "worktree", "remove", "--force", wt]).catch(() => undefined);
  }
}

/** Approve intent on a parked ticket: merge the parked PR now (deploy follows on
 *  the next reconcile pass, exactly as a human-merged draft PR does), or explain
 *  why there's nothing to merge. The merge itself is routed through
 *  `enqueueRepoWork` — the coordinator's ship-chain handle — so it can never
 *  overlap a build's own merge/tag/deploy sequence on the shared REPO checkout
 *  (two REPO-mutating ops racing there collide on `.git/index.lock`, which used
 *  to surface here as a false "conflict" for a merge that actually landed).
 *  Never throws to its caller's loop guard: every db.comment/obs.track call
 *  around the merge is best-effort, so a DB blip can't obscure (or throw past)
 *  the true merge outcome. `hadOtherNotes` only tunes the success-comment
 *  wording — whether this batch mixed in non-approve notes that approve
 *  superseded (approve carries no instructions, so they're dropped). */
async function handleApprove(m: FreshMention, enqueueRepoWork: EnqueueRepoWork, hadOtherNotes: boolean): Promise<void> {
  const prUrl = m.parked?.prUrl;
  const branch = m.parked?.branch ?? `auto/${m.key}`;
  const hasPr = Boolean(prUrl);
  const prMerged = hasPr ? await prIsMerged(prUrl as string) : false;
  const decision = decideApprove({ hasPr, prMerged });
  const author = (await db.displayName(m.askerUserId).catch(() => null)) ?? "maintainer";

  if (decision === "merge") {
    // Serialized behind the ship chain (same mutex enqueueShip uses for
    // build/ship): mark-ready + merge run only once nothing else is mutating the
    // shared checkout. On a merge conflict — the parked branch drifted from main,
    // which is the norm for an epic's later sibling phases — auto-rebase onto
    // current main (mechanical version-race resolution) and retry the merge ONCE,
    // instead of dumping the manual rebuild/re-approve loop on the maintainer.
    type MergeOutcome = { merged: true; rebasedTo?: string } | { merged: false; reason: string };
    let outcome: MergeOutcome;
    try {
      outcome = await enqueueRepoWork(async (): Promise<MergeOutcome> => {
        // Parked PRs are drafts — mark ready so the admin squash-merge can land.
        await exec("gh", ["pr", "ready", branch], { cwd: REPO }).catch(() => undefined);
        try {
          await ship.mergePr(branch);
          return { merged: true };
        } catch (firstErr) {
          const healed = await autoRebaseParkedBranch(branch).catch((e) => ({ ok: false as const, reason: String(e) }));
          if (!healed.ok) return { merged: false, reason: healed.reason || String(firstErr) };
          await exec("gh", ["pr", "ready", branch], { cwd: REPO }).catch(() => undefined);
          try {
            await ship.mergePr(branch);
            return { merged: true, rebasedTo: healed.version };
          } catch (secondErr) {
            return { merged: false, reason: String(secondErr) };
          }
        }
      });
    } catch (e) {
      outcome = { merged: false, reason: String(e) };
    }
    if (!outcome.merged) {
      log(`${m.key} approve → merge FAILED (${outcome.reason}) — parked with conflict guidance`);
      await db.comment(m.itemId, mergeConflictGuidance(m.key, branch, outcome.reason)).catch(() => undefined);
      await obs
        .track({ workItemId: m.itemId, ticketKey: m.key, kind: "parked", severity: "warn", message: `approve-merge failed — ${outcome.reason}`, data: { reason: "approve-merge failed", prUrl, branch, sessionId: m.parked?.sessionId } })
        .catch(() => undefined);
      return;
    }
    const healedNote = outcome.rebasedTo ? ` (auto-rebased onto main → v${outcome.rebasedTo})` : "";
    log(`${m.key} approved via comment — PR merged${healedNote}; deploy on next reconcile`);
    // #8: when the batch mixed approve with other notes, say so — approve wins in
    // combineIntents but carries no instructions, so those notes were dropped.
    const ignored = hadOtherNotes ? ", ignoring the other notes in this thread" : "";
    await db.comment(m.itemId, `Approved by ${author} — merging now${healedNote}; deploy follows automatically${ignored}.`).catch(() => undefined);
    await obs
      .track({ workItemId: m.itemId, ticketKey: m.key, kind: "queued-ship", message: `approved via comment — PR merged${healedNote}, deploy on next reconcile` })
      .catch(() => undefined);
    return;
  }
  if (decision === "reconcile-only") {
    log(`${m.key} approved but PR already merged — reconcile finishes the deploy`);
    await db.comment(m.itemId, "Already merged — deploy completes on my next pass.");
    return;
  }
  // nothing-built: no PR was ever opened (e.g. the build never got that far).
  log(`${m.key} approved but nothing was built to merge`);
  await db.comment(m.itemId, `There's nothing built to merge for ${m.key} yet. Reply with what you'd like changed and I'll resume where I left off, or say "rebuild" to start over from current main.`);
}

/** @Foreman mention processor — the ticket-comment channel (§ agent identity).
 *  Each pass: find privileged mentions not yet consumed (db.freshMentions), group
 *  them per ticket, then route:
 *  - ticket in `review` (parked): classify the owner's combined replies via
 *    combineIntents into ONE intent —
 *      · approve  → merge the parked PR now (handleApprove, via enqueueRepoWork
 *                   so the merge is serialized behind the ship chain);
 *      · rebuild  → full requeue to backlog (legacy path; the instruction is
 *                   re-read by instructionsFor() at build time);
 *      · instruct → enqueue a RESUME of the same session/worktree (resumeQueue),
 *                   drained by the coordinator into a build slot.
 *    Each of these advances the review watermark (columnEnteredAt) when the ticket
 *    finally moves, so a mention is consumed exactly once. freshMentions may now
 *    surface several fresh comments for the SAME parked ticket in one pass (every
 *    comment past the watermark, oldest first) — `texts` below folds all of them
 *    into one combineIntents call so, e.g., a later "approve" always outranks an
 *    earlier steering note in the same group.
 *  - any other column: REPLY in-thread via a read-only agent (Read/Grep/Glob in
 *    the repo — code-grounded answers, no shell, no edits) + ping the asker. The
 *    bot's reply timestamp is that path's watermark.
 *  `isInflight` reports whether a build/resume for an item is already running (so a
 *  duplicate resume isn't queued). `enqueueRepoWork` is the coordinator's ship-chain
 *  handle, threaded down to handleApprove so its merge never races a build's own
 *  REPO-mutating steps. Mentions by non-privileged members are filtered
 *  in db.freshMentions. Never throws — a mention hiccup must not stall delivery. */
async function processMentions(
  isInflight: (itemId: string) => boolean,
  enqueueRepoWork: EnqueueRepoWork,
): Promise<void> {
  let fresh: FreshMention[];
  try {
    fresh = await db.freshMentions();
  } catch (e) {
    log(`mention scan failed (${String(e)}) — skipping this pass`);
    return;
  }
  // Group by itemId, preserving comment order, so each ticket is routed ONCE over
  // its combined fresh comments (freshMentions may surface several per item).
  const byItem = new Map<string, FreshMention[]>();
  for (const m of fresh) {
    const g = byItem.get(m.itemId);
    if (g) g.push(m);
    else byItem.set(m.itemId, [m]);
  }
  for (const group of byItem.values()) {
    const m = group[0];
    try {
      if (killed()) return;
      if (m.columnKey === "review") {
        const texts = group.map((g) => g.question).filter((q) => q.trim().length > 0);
        const { intent, instructions } = combineIntents(texts);
        if (intent === "approve") {
          // #8: did the batch mix in any non-approve note that approve superseded?
          // (approve wins via combineIntents but carries no instructions.)
          const hadOtherNotes = texts.some((t) => classifyInstruction(t) !== "approve");
          await handleApprove(m, enqueueRepoWork, hadOtherNotes);
        } else if (intent === "rebuild") {
          // Unchanged legacy path: full requeue to backlog (the instruction is
          // re-consumed by instructionsFor() when the fresh build runs).
          log(`${m.key} @Foreman rebuild on parked ticket — requeueing`);
          await db.moveColumn(m.itemId, "backlog");
          await db.comment(
            m.itemId,
            `Got it — requeued with your instructions. I'll rebuild ${m.key} accordingly on my next pass.`,
          );
        } else {
          // instruct: resume the SAME session/worktree with these notes. Enqueue for
          // the coordinator; dedupe by itemId and skip if already building/queued.
          if (isInflight(m.itemId) || resumeQueue.has(m.itemId)) {
            log(`${m.key} resume already queued/in-flight — skipping duplicate`);
          } else {
            resumeQueue.set(m.itemId, { m, instructions });
            await db.comment(m.itemId, "On it — resuming where I left off with your notes.");
            log(`${m.key} @Foreman instruction on parked ticket — queued for resume`);
          }
        }
      } else {
        log(`${m.key} @Foreman question (${m.columnKey}) — drafting reply`);
        const r = await runAgent(
          REPO,
          replyPrompt({
            key: m.key,
            title: m.title,
            columnKey: m.columnKey,
            description: m.description,
            thread: m.thread,
            question: m.question,
          }),
          { orgId: m.orgId, allowedTools: "Read,Grep,Glob", maxTurns: 15, timeoutMs: 5 * 60_000 },
        );
        const reply = r.ok && r.log.trim() ? r.log.trim().slice(-2000) : "";
        if (!reply) {
          log(`${m.key} reply agent failed — leaving the mention for the next pass`);
          continue;
        }
        // Finished tickets invite "can you also…" comments, but replies alone
        // never trigger work — tell the asker how to actually re-action it, in
        // the reply itself (the non-obvious part of the mention model).
        const DONE_COLUMNS = ["done", "completed", "closed", "shipped"];
        const actionHint = DONE_COLUMNS.includes(m.columnKey)
          ? "\n\n---\n_Want me to action this? Move the ticket back to **Backlog** — comments here ride along as instructions for the rebuild. (Or file it as new feedback to keep this ticket closed.)_"
          : "";
        await db.comment(m.itemId, reply + actionHint);
        await db.notifyReply(m.itemId, m.askerUserId, m.key, reply);
        await obs.track({ workItemId: m.itemId, ticketKey: m.key, kind: "mention-reply", message: `replied to @Foreman mention on ${m.key}` });
      }
    } catch (e) {
      if (e instanceof NoForemanCredentialError) {
        // The reply agent needs this org's Foreman subscription; it's not connected,
        // so skip the mention (log-and-continue) rather than crashing the pass.
        log(`${m.key} mention skipped — no Foreman Claude connection`);
      } else {
        log(`${m.key} mention handling failed (${String(e)}) — continuing`);
      }
    }
  }
}

/** RESUME a parked ticket in place (the "instruct" intent): the change was already
 *  built + parked for review, and the maintainer replied with steering. Re-checkout
 *  the SAME branch/worktree, resume the SAME agent session with those notes (falling
 *  back to a fresh agent seeded with the ticket brief + current PR diff when the
 *  session is gone or errors), then run the IDENTICAL post-build gate as processOne
 *  (repair loop → risk → adversarial reviewer, all shared helpers). SAFE → hand the
 *  EXISTING PR to the ship worker (Built.prUrl set, so shipBuilt merges it in place
 *  rather than opening a new one); RISKY / rejected / incomplete → push the updated
 *  branch (the PR refreshes in place) and re-park with the NEW sessionId. A missing
 *  branch (nothing was ever pushed) falls back to a rebuild requeue. Coordinator
 *  gates the drain, so this never runs in DRY. */
async function processResume(
  entry: { m: FreshMention; instructions: string[] },
  workerOpts: { testDbUrl?: string } = {},
): Promise<{ ship?: Built }> {
  const { m, instructions } = entry;
  const key = m.key;
  // F2: parks from v2.189–2.195 recorded a PR but not the branch in the event
  // `data`. When there's a PR to resume against, fall back to the conventional
  // `auto/<KEY>` branch (the same fallback handleApprove uses) rather than
  // discarding the build with a rebuild requeue. Only a park with NEITHER branch
  // nor PR (a true no-build park, e.g. "agent did not complete") drops through.
  const branch = m.parked?.branch ?? (m.parked?.prUrl ? `auto/${key}` : undefined);
  const wt = `/tmp/foreman/${key}`;
  let keepWorktree = false;

  // No branch and no PR (e.g. the "agent did not complete" park, which never pushed
  // anything) → nothing to resume. Fall back to a rebuild: requeue to backlog so a
  // fresh build picks up the instructions via instructionsFor().
  if (!branch) {
    log(`${key} resume requested but no parked branch — falling back to rebuild`);
    await db.moveColumn(m.itemId, "backlog");
    await db.comment(m.itemId, `I don't have a prior build to resume for ${m.key}, so I've requeued it — I'll rebuild it with your notes on my next pass.`);
    return {};
  }

  const brief = briefFromParts(key, m.title, m.description, await db.triageFor(m.itemId).catch(() => null));

  const haltIfKilled = async (): Promise<boolean> => {
    if (!killed()) return false;
    log(`${key} resume halted by kill switch — left in progress`);
    await db.comment(m.itemId, "Halted by kill switch mid-resume; left in progress. Move the card back to Backlog to retry.").catch(() => undefined);
    await restoreMain();
    return true;
  };

  // Re-materialize the worktree at the parked branch. The branch lives on origin
  // (the park's pushBranch put it there); fetch it, then check it out. Force-clean
  // any stale dir first — `worktree add` fails hard on an existing dir.
  rmSync(wt, { recursive: true, force: true });
  await exec("git", ["-C", REPO, "worktree", "prune"]).catch(() => undefined);
  await exec("git", ["-C", REPO, "fetch", "origin", "main"]);
  try {
    await exec("git", ["-C", REPO, "fetch", "origin", branch]);
    await exec("git", ["-C", REPO, "worktree", "add", "-B", branch, wt, `origin/${branch}`]);
  } catch (e) {
    // The branch is gone from origin (deleted after a prior merge, or never pushed)
    // → nothing to resume; requeue as a rebuild.
    log(`${key} resume branch origin/${branch} unavailable (${String(e)}) — falling back to rebuild`);
    await exec("git", ["-C", REPO, "worktree", "remove", "--force", wt]).catch(() => undefined);
    await db.moveColumn(m.itemId, "backlog");
    await db.comment(m.itemId, `The prior build branch for ${m.key} is no longer available, so I've requeued it — I'll rebuild it with your notes on my next pass.`);
    return {};
  }
  try {
    symlinkSync(join(REPO, "node_modules"), join(wt, "node_modules"), "dir");
  } catch (e) {
    log(`${key} node_modules symlink failed (checks may gate): ${String(e)}`);
  }

  try {
    if (await haltIfKilled()) return {};

    // Resume the SAME agent session with the notes. No session persisted → skip
    // straight to the context fallback (a bare resumePrompt on a fresh session has
    // no memory of the build). If the resume itself errors, fall back too: a FRESH
    // agent seeded with the ticket brief + current PR diff reconstructs the context.
    let agent: AgentResult = m.parked?.sessionId
      ? await runAgent(wt, resumePrompt(key, instructions), { orgId: m.orgId, resume: m.parked.sessionId, testDbUrl: workerOpts.testDbUrl })
      : { ok: false, log: "", sessionId: null };
    if (!agent.ok) {
      const { stdout: prDiff } = await exec("git", ["-C", wt, "diff", "origin/main...HEAD"], { maxBuffer: 32 * 1024 * 1024 });
      agent = await runAgent(wt, resumeContextPrompt({ key, title: m.title, description: m.description }, prDiff, instructions), { orgId: m.orgId, testDbUrl: workerOpts.testDbUrl });
    }
    if (await haltIfKilled()) return {};

    /** Re-park the resumed ticket: push the updated branch so the EXISTING PR
     *  reflects the resume, then move to review + audit comment + parked event with
     *  the NEW sessionId. Never opens a new PR (one already exists on this branch). */
    const reparkResume = async (reason: string, checkLog?: string, processNote?: string): Promise<void> => {
      log(`${key} RESUME GATED (${reason}) → In Review`);
      await ship.pushBranch(branch).catch(() => undefined);
      const { commit, subject } = await ship.headInfo(wt);
      let version = "";
      try { version = ship.readVersion(wt); } catch { /* corrupt package.json → surfaced by checks/reason */ }
      await db.moveColumn(m.itemId, "review");
      await db.comment(m.itemId, formatAudit({ key, outcome: "review", summary: subject, reason, version, branch, prUrl: m.parked?.prUrl, commit, checkLog, process: processNote }));
      await db.notifyDelivery(m.itemId, "parked", { key, title: m.title, reason, version, prUrl: m.parked?.prUrl });
      await obs.track({ workItemId: m.itemId, ticketKey: m.key, kind: "parked", severity: "warn", message: reason, data: { reason, version, sessionId: agent.sessionId ?? undefined, branch, worktreePath: wt, prUrl: m.parked?.prUrl } });
    };

    if (!agent.ok) {
      await reparkResume("resume agent did not complete (timeout, spawn error, or non-zero exit)");
      return {};
    }

    // Empty diff after a resume means the change was reverted back to main — nothing
    // to ship. Re-park so a human sees it rather than silently closing the PR.
    let diff = await diffSummary(wt);
    if (diff.files.length === 0) {
      await reparkResume("resume produced no diff against main");
      return {};
    }

    // IDENTICAL post-build gate as processOne, via the shared helpers.
    setPhase(m.itemId, "checks");
    const repair = await repairLoop(
      key,
      m.orgId,
      wt,
      agent.sessionId ?? undefined,
      workerOpts.testDbUrl,
      haltIfKilled,
      (round) => setPhase(m.itemId, "repair", { repairRound: round }),
    );
    if (repair.halted) return {};
    const { checks, repairs } = repair;
    diff = await diffSummary(wt);
    let version = "";
    try { version = ship.readVersion(wt); } catch { /* corrupt package.json → checks gate */ }
    const { commit, subject } = await ship.headInfo(wt);
    const risk = classifyRisk(diff);
    const processParts: string[] = ["resumed with maintainer notes"];
    if (repairs > 0) processParts.push(`${repairs} repair round${repairs > 1 ? "s" : ""}`);

    if (!checks.ok || risk.gated) {
      await reparkResume(!checks.ok ? "checks failed" : risk.reasons.join("; "), checks.ok ? undefined : checks.log, processParts.join(" · "));
      return {};
    }

    setPhase(m.itemId, "review");
    const verdict = await reviewFinalDiff(brief, m.orgId, wt);
    if (!verdict.approve) {
      await reparkResume(`reviewer rejected — ${verdict.reason}`, undefined, processParts.join(" · "));
      return {};
    }
    processParts.push(`reviewer approved — ${verdict.reason}`);
    const processNote = processParts.join(" · ");

    // Coordinated-release gate (COSMOS-118) — same hold as processOne: a phase child
    // of a "coordinated" epic never ships on its own; re-park it (green+approved,
    // held) with the epic's aggregate readiness until every sibling is ready.
    const coord = await db.epicCoordination(m.itemId).catch(() => null);
    if (coord && coord.mode === "coordinated") {
      const summary = aggregateReadiness(coord.mode, coord.siblings);
      await reparkResume(`held for coordinated release of ${coord.epicKey ?? "its epic"} — ${summary.label}`, undefined, processNote);
      return {};
    }

    // SAFE → hand the EXISTING PR to the serialized ship worker (Built.prUrl set).
    log(`${key} RESUME SAFE → queued for ship (built v${version})`);
    setPhase(m.itemId, "queued-ship");
    await obs.track({ workItemId: m.itemId, ticketKey: m.key, kind: "queued-ship", message: `resume SAFE → queued for ship (built v${version})` });
    if (await haltIfKilled()) return {};

    let changelogEntry: string | null = null;
    if (diff.files.includes("src/lib/changelog.ts")) {
      try {
        const cl = readFileSync(join(wt, "src/lib/changelog.ts"), "utf8");
        changelogEntry = extractTopChangelogEntry(cl)?.entry ?? null;
      } catch { /* unreadable changelog → ship without an entry rewrite */ }
    }
    keepWorktree = true; // the ship worker owns cleanup from here
    return {
      ship: {
        itemId: m.itemId,
        key,
        title: m.title,
        classification: brief.classification,
        branch,
        wt,
        sessionId: agent.sessionId ?? undefined,
        subject,
        commit,
        processNote,
        changelogEntry,
        bumpKind: brief.classification === "FEATURE" ? "minor" : "patch",
        prUrl: m.parked?.prUrl,
      },
    };
  } finally {
    if (!keepWorktree) await exec("git", ["-C", REPO, "worktree", "remove", "--force", wt]).catch(() => undefined);
    await exec("git", ["-C", REPO, "checkout", "-f", "main"]).catch(() => undefined);
  }
}

/** Reconcile approved (merged) gated tickets. When Foreman gates a risky change it
 *  opens a DRAFT PR on `auto/<KEY>` and parks the ticket in `review`; a human
 *  then reviews + merges it to main. This step closes that loop: detect the merged
 *  PR, deploy main, and move the ticket to `done` — or, if the merge is already
 *  live, just close it.
 *
 *  NEVER runs in DRY — it deploys to prod. Refreshes the shared checkout to a
 *  pristine origin/main up front (readVersion(REPO) must read main's merged bump)
 *  and never leaves main dirty. At most ONE gated deploy per pass (serialized), so
 *  a batch of merged PRs can't stampede concurrent prod deploys. Per-ref work is
 *  wrapped so a `gh`/git hiccup skips that ref (reconcile re-runs next pass) rather
 *  than crashing the loop; only a real deploy-gate failure escapes, to feed main()'s
 *  circuit breaker. */
async function reconcileGated(): Promise<void> {
  if (DRY) return; // deploys to prod — never in a dry preview

  // Compute pending-gated BEFORE any git op. REPO is the shared, interactively-used
  // checkout and can hold uncommitted work; an idle pass (nothing pending) must NOT
  // `git checkout/fetch/reset --hard` it and silently discard that work. Only refresh
  // main when there is at least one pending gated ref to actually deploy.
  const entries = readLedger(LEDGER);
  const pending = pendingGated(entries);
  if (pending.length === 0) return;

  // reconcile is non-DRY, so its outcomes always land in the real LEDGER.
  const record = (e: Omit<LedgerEntry, "ts">): void =>
    appendLedger(LEDGER, { ...e, ts: new Date().toISOString() });

  // Refresh main to origin: the merged PR lives there now, and readVersion(REPO)
  // must see main's bumped package.json. Best-effort steps, but never leave main
  // dirty — end on a clean checkout tracking origin/main.
  await exec("git", ["-C", REPO, "checkout", "main"]).catch(() => undefined);
  await exec("git", ["-C", REPO, "fetch", "origin", "main"]).catch(() => undefined);
  await exec("git", ["-C", REPO, "reset", "--hard", "origin/main"]).catch(() => undefined);

  // Reuse each ref's most-recent (gated) entry for the title/classification we
  // record back, so a reconcile outcome line stays consistent with its history.
  const lastByRef = new Map<string, LedgerEntry>();
  for (const e of entries) lastByRef.set(e.ticket, e);

  for (const ref of pending) {
    try {
      // Refs are per-project (<KEY>-<n>) — parse both halves; an unparseable ref
      // (shouldn't happen, ledger entries are always written via buildRef) is
      // skipped rather than crashing reconcile for every other pending ref.
      const parsed = parseRef(ref);
      if (!parsed) continue;
      // Is the draft PR now merged? A gh error / not-found (no PR on that branch,
      // or a transient failure) → treat as not-yet-merged and skip this ref.
      let merged = false;
      try {
        const { stdout } = await exec("gh", ["pr", "view", `auto/${ref}`, "--json", "state"], { cwd: REPO });
        merged = (JSON.parse(stdout) as { state?: string }).state === "MERGED";
      } catch {
        continue;
      }
      if (!merged) continue;

      const item = await db.resolveTicket(parsed.key, parsed.number);
      if (!item) continue;

      const prior = lastByRef.get(ref);
      const title = prior?.title ?? ref;
      const classification: "BUG" | "FEATURE" = prior?.classification ?? "FEATURE";
      const version = ship.readVersion(REPO); // main's current (merged) version

      // Already live? prod's health version >= main's → the merge is already
      // deployed; just close the ticket without redeploying. If health is
      // unreachable, assume not-yet-live and fall through to deploy.
      let prodVersion = "0.0.0";
      try {
        const res = await fetch("http://127.0.0.1:8090/api/health");
        prodVersion = ((await res.json()) as { version?: string }).version ?? "0.0.0";
      } catch {
        /* health unreachable — treat as not-yet-live and deploy below */
      }
      if (compareVersions(prodVersion, version) >= 0) {
        // Already `done` (e.g. a human moved it) → skip the redundant column write
        // (uses resolveTicket's columnKey); still record shipped to clear the gate.
        if (item.columnKey !== "done") await db.moveColumn(item.id, "done");
        await db.comment(item.id, `Approved + already live in v${version}.`);
        record({ ticket: ref, title, classification, resolution: "shipped", version });
        log(`${ref} approved + already live v${version} → done`);
        continue;
      }

      // Kill-switch checkpoint: a `touch FOREMAN_STOP` before the deploy must NOT
      // push a release to prod. Leave the ticket parked; reconcile retries next arm.
      if (killed()) {
        log(`${ref} reconcile halted by kill switch before deploy — left in review`);
        return;
      }

      // Deploy main. Ensure the tag exists (release.yml builds the image on tag
      // push); the human merge may not have tagged it, and a re-run must not die on
      // an already-existing tag/ref — ignore both.
      await exec("git", ["-C", REPO, "tag", `v${version}`]).catch(() => undefined);
      await exec("git", ["-C", REPO, "push", "origin", `v${version}`]).catch(() => undefined);
      if (!(await ship.waitForImage(version))) {
        await db.comment(item.id, `Approved; image build for v${version} pending/failed — will retry next pass.`);
        log(`${ref} approved but image v${version} not ready — retry next pass`);
        return; // not a gate — just try again next pass
      }
      // deploy-migrate is the safe superset: applies any pending migration, else no-op.
      const ok = await ship.deploy(version, true);
      if (ok) {
        if (item.columnKey !== "done") await db.moveColumn(item.id, "done");
        await db.comment(item.id, `Shipped approved change in v${version}.`);
        record({ ticket: ref, title, classification, resolution: "shipped", version });
        log(`${ref} shipped approved change v${version} → done`);
      } else {
        // Deploy health-gate failed. Roll back + re-park as best-effort, but
        // guarantee the circuit-breaker signal fires REGARDLESS: a DB/gh blip in
        // the cleanup below must not swallow a real deploy failure and leave it
        // uncounted (mirrors processOne's M4). The breaker-feeding throw after this
        // try/catch is UNCONDITIONAL.
        try {
          await ship.rollback(version);
          await db.moveColumn(item.id, "review");
          await db.comment(item.id, "Approved but deploy health-gate failed; rolled back. Still parked.");
          record({ ticket: ref, title, classification, resolution: "gated" });
          log(`${ref} approved deploy health-gate failed — rolled back, still parked`);
        } catch (cleanupErr) {
          log(`${ref} reconcile deploy-gate cleanup error (continuing to circuit breaker): ${String(cleanupErr)}`);
        }
        // Feed main()'s circuit breaker (repeated deploy-gate failures disarm).
        throw new Error("deploy gate failed (approved reconcile rolled back)");
      }
      return; // one gated deploy per pass (serialized)
    } catch (e) {
      // A real deploy-gate failure must reach main()'s breaker — re-throw it. Any
      // other per-ref hiccup (gh/git/DB) is isolated: skip this ref and let
      // reconcile re-run next pass.
      if (String(e).includes("deploy gate")) throw e;
      log(`reconcile ${ref} skipped: ${String(e)}`);
    }
  }
}

async function main(): Promise<void> {
  if (existsSync(LOCK)) {
    log("another foreman holds the lock — exiting");
    return;
  }
  writeFileSync(LOCK, String(process.pid));
  log(`foreman started (pid ${process.pid})${DRY ? " — DRY RUN (no merge/deploy/DB-writes)" : ""}`);
  // Boot the host row + a boot event. These fire even in DRY (the only feed
  // writes that do) so the status surface shows a live daemon during a preview.
  await obs.boot({ daemonVersion: pkgVersion, pid: process.pid, workerTarget: MAX_SLOTS });
  await obs.track({ kind: "boot", message: `foreman started (pid ${process.pid})` });
  // M3: reclaim anything a prior crash left behind — a leftover staging dir plus
  // the worktree registration that points at it — so the per-ticket `worktree add`
  // below can't be blocked by a stale entry.
  try {
    rmSync("/tmp/foreman", { recursive: true, force: true });
  } catch {
    /* best-effort: leftover staging dirs are the only thing blocked, and rare */
  }
  await exec("git", ["-C", REPO, "worktree", "prune", "--expire", "now"]).catch(() => undefined);
  // Empty scratch cwd for the read-only judges (I3) — created once, reused.
  mkdirSync(SCRATCH, { recursive: true });
  // Reclaim any ticket a prior crashed/killed run left stuck in `in-progress`
  // (nothing is working it under this single-daemon lock) back to the pickable pool.
  if (!DRY) {
    const reclaimed = await db.reclaimStranded();
    if (reclaimed.length > 0) {
      const msg = `reclaimed ${reclaimed.length} stranded in-progress → backlog: ${reclaimed.map((r) => r.ref).join(", ")}`;
      log(msg);
      // F4: one org-scoped event PER reclaimed item (orgId auto-resolves from
      // workItemId inside track()) instead of a single org-less aggregate that
      // leaked every org's ticket refs into the org-less feed. Aggregate log() stays.
      for (const r of reclaimed) {
        await obs.track({ workItemId: r.id, ticketKey: r.ref, kind: "reclaimed", message: `${r.ref} reclaimed → backlog (stranded in-progress at startup)` });
      }
    }
    // Snap every linked feedback status back to its ticket's actual column —
    // heals any drift from paths that bypassed the live sync (see db.mts).
    const resynced = await db.resyncFeedbackTruth().catch(() => 0);
    if (resynced > 0) {
      const msg = `feedback ground-truth resync over ${resynced} linked items`;
      log(msg);
      await obs.track({ kind: "resync", message: msg });
    }
  }
  let consecutiveDeployFails = 0;
  // Reconcile gets its OWN deploy-failure breaker, independent of the shared
  // consecutiveDeployFails above: otherwise an unrelated backlog ticket shipping
  // between two reconcile attempts would reset that shared counter, so a
  // persistently-broken approved deploy would retry (real deploy+rollback churn)
  // forever without ever tripping. Same threshold + halt action. (I3)
  let reconcileDeployFails = 0;
  const BREAKER = 2;
  // Deploy-breaker snapshot for the heartbeat. It lives here (not beside setPhase)
  // because it reads the loop's function-local failure counters. There's no
  // aggregate build-failure streak variable (build failures gate per-ticket), so
  // `build` is 0; `deploy` is the worse of the two independent deploy streaks.
  const breakerSnapshot = (): { build: number; deploy: number; tripped: boolean } => ({
    build: 0,
    deploy: Math.max(consecutiveDeployFails, reconcileDeployFails),
    tripped: consecutiveDeployFails >= BREAKER || reconcileDeployFails >= BREAKER,
  });
  // DRY surveys each backlog ticket exactly once: terminal column moves are
  // skipped in DRY, so without this the picked ticket stays in `backlog` and the
  // loop would re-process the same top-priority one forever. (I1)
  const processed = new Set<string>();
  // Per-ticket failure counter: a ticket that throws EARLY in processOne (before
  // the in-progress move — e.g. an expired token or a DB blip in historyCandidates)
  // stays in `backlog` and would be re-picked immediately, hot-looping the CPU. We
  // back off after every failure and, after too many on the same id, park it so the
  // loop makes progress. (I4)
  const attempts = new Map<string, number>();
  const MAX_ATTEMPTS = 3;
  // ── Parallel build pool ── builds run concurrently (per-worker test DBs so
  // suites can't collide); SHIP is a strictly-serialized promise chain.
  const inflight = new Map<string, Promise<void>>();
  const freeSlots = [...Array(MAX_SLOTS).keys()];
  let workerDbUrls: (string | undefined)[] = Array(MAX_SLOTS).fill(undefined);
  let slotCap = MAX_SLOTS;
  if (MAX_SLOTS > 1) {
    try {
      workerDbUrls = await ensureWorkerDbs(MAX_SLOTS);
      log(`provisioned ${MAX_SLOTS} worker test DBs`);
    } catch (e) {
      slotCap = 1; // never run parallel suites against ONE shared test DB
      log(`worker DB provisioning failed (${String(e)}) — capping at a single worker`);
    }
  }
  let shipChain: Promise<void> = Promise.resolve();
  const enqueueShip = (b: Built): void => {
    shipChain = shipChain
      // The in-flight registry entry (phase "queued-ship", kept alive through this
      // call by the claim task's keepMeta) must survive until the ship attempt
      // itself ends — drop it here, right as shipBuilt settles, so it's removed
      // exactly once regardless of outcome (success or thrown).
      .then(() => shipBuilt(b).finally(() => inFlightMeta.delete(b.itemId)))
      .then(async (r) => {
        if (r.deployFailed) {
          if (++consecutiveDeployFails >= BREAKER) {
            log("circuit breaker: 2 deploy failures — disabling");
            writeFileSync(STOP, "circuit-breaker");
            await obs.track({ kind: "breaker", severity: "error", message: "circuit breaker tripped — 2 consecutive deploy failures; daemon stopping" });
            // breaker fanout rides the parked channel; generic notifyOrgOwners arrives with the alert endpoint
            await db.notifyDelivery(b.itemId, "parked", { key: b.key, title: b.title, reason: "circuit breaker tripped — daemon stopped" });
          }
        } else {
          consecutiveDeployFails = 0;
        }
      })
      .catch((e) => log(`${b.key} ship worker error: ${String(e)}`));
  };
  // The approve path's handle onto the SAME mutex: a comment-triggered merge
  // (handleApprove) is a REPO-mutating op too, so it rides this chain instead of
  // running inline in the coordinator loop — otherwise it could overlap a
  // build's own merge/tag/deploy sequence and collide on `.git/index.lock`.
  // Unlike enqueueShip (fire-and-forget, itemId-keyed metadata cleanup), this
  // returns the enqueued call's OWN promise so handleApprove can await its true
  // result; the chain link itself (`shipChain =`) always resolves — success or
  // failure — so one failed approve-merge can never stall a later-queued ship.
  const enqueueRepoWork: EnqueueRepoWork = (work) => {
    const result = shipChain.then(work);
    shipChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  try {
    while (!killed()) {
      try {
        if (!(await db.autonomyEnabled())) {
          log("autonomy disabled — idle");
          await idleSleep(60_000);
          continue;
        }
        // Reconcile FIRST: deploy anything a human merged since last pass (an
        // approved gated PR) before spending a build slot on new backlog work.
        // No-op in DRY and when nothing is pending-gated. A deploy-gate failure
        // here trips reconcile's OWN circuit breaker (reconcileDeployFails),
        // independent of processOne's consecutiveDeployFails. (I3)
        try {
          await reconcileGated();
          reconcileDeployFails = 0; // a clean / no-op / idempotent pass clears it
        } catch (e) {
          if (String(e).includes("deploy gate")) {
            reconcileDeployFails++;
            log(`reconcile deploy failed (${reconcileDeployFails}/${BREAKER})`);
            if (reconcileDeployFails >= BREAKER) {
              log("circuit breaker: 2 deploy failures — disabling");
              writeFileSync(STOP, "circuit-breaker");
              // F2: mirror the enqueueShip breaker site — surface the trip in-app so the
              // console reads "Circuit breaker", not a silently-decaying "Stale". No item
              // is in scope here (the failing ref lives inside reconcileGated), so the
              // org-less breaker event is the whole fix (spec-sanctioned).
              await obs.track({ kind: "breaker", severity: "error", message: "circuit breaker tripped — reconcile deploy failed twice; daemon stopping" });
            }
          } else {
            log(`reconcile skipped: ${String(e)}`); // transient gh/git/db — not a deploy failure
          }
        }
        if (killed()) continue; // breaker may have just fired — don't start a build

        // @Foreman mentions: route approve/rebuild/instruct on parked tickets +
        // answer questions BEFORE picking new work — a maintainer's instruction
        // outranks the queue. Never in DRY (it comments + moves cards on the live
        // board, and enqueues resumes). `inflight.has` lets it skip a duplicate
        // resume for an item already building.
        if (!DRY) await processMentions((id) => inflight.has(id), enqueueRepoWork);
        if (killed()) continue;
        // ── fill build slots, then pump on any completion ──
        const backlog = await db.getBacklog();
        // Curate To-do to PLAN_TARGET before claiming, on the SAME backlog array
        // the claim loop consumes — a promotion here retiers the item for this
        // pass's pickNext. Failure-isolated: never blocks or crashes the pass.
        await planPass(backlog).catch((e) => log(`planner error: ${String(e)}`));
        const pool = DRY ? backlog.filter((b) => !processed.has(b.id)) : backlog;
        // LIVE target from org settings (clamped by provisioning + env cap).
        const workerTarget = DRY ? 1 : Math.min(slotCap, await db.deliveryWorkerTarget().catch(() => 1));
        await obs.heartbeat({
          workerTarget,
          slotsBusy: inflight.size,
          queueDepth: pool.length,
          inFlight: [...inFlightMeta.values()],
          breaker: breakerSnapshot(),
          stopFileSeen: killed(),
        });
        while (inflight.size < workerTarget && freeSlots.length > 0 && !killed()) {
          // Drain a queued RESUME first — a maintainer's steering on a parked ticket
          // outranks new backlog work. Never in DRY (resumeQueue is only filled by
          // the !DRY processMentions, so it's always empty here in a dry preview).
          const resumeItemId = DRY ? undefined : (resumeQueue.keys().next().value as string | undefined);
          if (resumeItemId !== undefined) {
            const resumeEntry = resumeQueue.get(resumeItemId)!;
            resumeQueue.delete(resumeItemId);
            // Already building (shouldn't happen — processMentions guards on inflight —
            // but belt-and-suspenders): drop the queue entry, it'll re-surface next
            // pass if still parked.
            if (inflight.has(resumeItemId)) continue;
            // Atomic claim: flip review → in-progress. A lost claim (a human dragged
            // it, or it already shipped) just drops the resume from this pass.
            if (!(await db.claimParked(resumeItemId))) {
              log(`${resumeEntry.m.key} resume claim lost (no longer in review) — skipping`);
              continue;
            }
            const rslot = freeSlots.shift()!;
            inFlightMeta.set(resumeItemId, {
              key: resumeEntry.m.key, itemId: resumeItemId, orgId: resumeEntry.m.orgId, title: resumeEntry.m.title,
              phase: "building", since: new Date().toISOString(),
            });
            await obs.track({ workItemId: resumeItemId, orgId: resumeEntry.m.orgId, ticketKey: resumeEntry.m.key, kind: "claimed", message: `claimed ${resumeEntry.m.key} for resume` });
            const resumeTask = (async () => {
              // keepMeta mirrors the build task: kept true when the resume hands off to
              // the ship queue, so enqueueShip's chain owns dropping the registry entry.
              let keepMeta = false;
              try {
                const out = await processResume(resumeEntry, { testDbUrl: workerDbUrls[rslot] });
                if (out.ship) {
                  keepMeta = true;
                  enqueueShip(out.ship);
                }
              } catch (e) {
                if (e instanceof NoForemanCredentialError) {
                  // No connected Foreman subscription for this org — can't resume.
                  // Leave it parked in review with a clear reason (connect it on the
                  // Foreman page, then steer again); a resume is mention-driven, so
                  // there's nothing to hot-loop. No crash.
                  log(`${resumeEntry.m.key} resume skipped — no Foreman Claude connection`);
                  await db.moveColumn(resumeItemId, "review").catch(() => undefined);
                  await obs.track({ workItemId: resumeItemId, orgId: resumeEntry.m.orgId, ticketKey: resumeEntry.m.key, kind: "parked", severity: "warn", message: "no Foreman Claude connection — connect it on the Foreman page", data: { reason: "no-foreman-connection" } });
                } else {
                  // A failed resume re-parks with the error (no attempts/backoff — the
                  // maintainer can steer again). Best-effort: never let it escape the slot.
                  log(`${resumeEntry.m.key} resume error: ${String(e)} — re-parking`);
                  await db.moveColumn(resumeItemId, "review").catch(() => undefined);
                  await db.comment(resumeItemId, `Resume failed unexpectedly — left in review. Last error: ${String(e)}`).catch(() => undefined);
                }
              } finally {
                inflight.delete(resumeItemId);
                if (!keepMeta) inFlightMeta.delete(resumeItemId);
                freeSlots.push(rslot);
              }
            })();
            inflight.set(resumeItemId, resumeTask);
            continue; // one dispatch per iteration
          }

          const candidates = pool.filter(
            (c) => !inflight.has(c.id) && (attempts.get(c.id) ?? 0) < MAX_ATTEMPTS,
          );
          const next = pickNext(candidates);
          if (!next) break;
          const item = backlog.find((c) => c.id === next.id);
          if (!item) break;
          // Atomic claim: two coordinators-worth of races (or a human drag) can't
          // double-build a ticket. A lost claim just drops it from this pass.
          if (!DRY && !(await db.claimTicket(item.id))) {
            pool.splice(pool.findIndex((c) => c.id === item.id), 1);
            continue;
          }
          const slot = freeSlots.shift()!;
          const ref = buildRef(item.projectKey, item.ticketNumber);
          inFlightMeta.set(item.id, {
            key: ref, itemId: item.id, orgId: item.orgId, title: item.title,
            phase: "building", since: new Date().toISOString(),
          });
          // The in-memory registry set above is harmless in DRY, but a "claimed"
          // event is not — DRY never calls db.claimTicket, so there is no real
          // claim to report. Gate it on !DRY like the other decision events.
          if (!DRY) await obs.track({ workItemId: item.id, orgId: item.orgId, ticketKey: ref, kind: "claimed", message: `claimed ${ref} for build` });
          const task = (async () => {
            // Kept true once the build hands off to the ship queue, so the finally
            // below leaves the registry entry (phase "queued-ship") in place for the
            // ship attempt — enqueueShip's own chain drops it when shipping ends.
            let keepMeta = false;
            try {
              const out = await processOne(item, { testDbUrl: workerDbUrls[slot] });
              attempts.delete(item.id);
              if (out.ship) {
                keepMeta = true;
                enqueueShip(out.ship);
              }
            } catch (e) {
              if (e instanceof NoForemanCredentialError) {
                // This item's org has no connected Foreman Claude subscription, so no
                // agent can run for it. Return it to backlog (it builds once the org
                // connects on the Foreman page) with a clear parked reason, and count
                // the attempt so an unconnected org drops out of the candidate pool
                // after MAX_ATTEMPTS instead of hot-looping the slot — the daemon keeps
                // serving connected orgs and idles cleanly, never crash-loops.
                log(`${ref} skipped — no Foreman Claude connection`);
                attempts.set(item.id, (attempts.get(item.id) ?? 0) + 1);
                if (!DRY) {
                  await db.moveColumn(item.id, "backlog").catch(() => undefined);
                  await obs.track({ workItemId: item.id, orgId: item.orgId, ticketKey: ref, kind: "parked", severity: "warn", message: "no Foreman Claude connection — connect it on the Foreman page", data: { reason: "no-foreman-connection" } });
                }
              } else {
                log(`${item.id} error: ${String(e)}`);
                const n = (attempts.get(item.id) ?? 0) + 1;
                attempts.set(item.id, n);
                if (n >= MAX_ATTEMPTS && !DRY) {
                  log(`${item.id} failed ${n}× — parking for review so the loop can progress`);
                  await db.moveColumn(item.id, "review").catch(() => undefined);
                  await db
                    .comment(item.id, `Repeatedly failed to process (${n} attempts) — needs a human. Last error: ${String(e)}`)
                    .catch(() => undefined);
                  await obs.track({ workItemId: item.id, kind: "gated", severity: "warn", message: `repeatedly failed (${n} attempts) — parked for review` });
                }
                await idleSleep(30_000); // bounded backoff without hot-looping the slot
              }
            } finally {
              inflight.delete(item.id);
              if (!keepMeta) inFlightMeta.delete(item.id);
              freeSlots.push(slot);
            }
          })();
          inflight.set(item.id, task);
          if (DRY) {
            await task; // DRY stays strictly sequential (single survey pass)
            processed.add(item.id);
          }
        }
        if (inflight.size === 0) {
          await idleSleep(60_000);
          continue;
        }
        // Wake on ANY completion (or the tick) to refill slots / run housekeeping.
        await Promise.race([...inflight.values(), idleSleep(20_000)]);
      } catch (e) {
        // Control-plane hiccup (e.g. a transient DB error in autonomyEnabled /
        // getBacklog): log and idle rather than tearing the daemon down.
        log(`control-loop error: ${String(e)} — idling`);
        await idleSleep(30_000);
      }
      if (killed()) break;
    }
    // Drain: let in-flight builds hit their kill checkpoints and the ship chain
    // finish its current (serialized) step before releasing the lock.
    if (inflight.size > 0) log(`draining ${inflight.size} in-flight build(s)…`);
    await Promise.allSettled([...inflight.values()]);
    await shipChain.catch(() => undefined);
    // Final truthful heartbeat (F1): the pump loop stops the instant `killed()` goes
    // true, so a breaker trip / STOP file / `systemctl stop` would otherwise leave the
    // last-written state reading healthy — the console pill then decays to "Stale"
    // instead of "Circuit breaker". Write the real shutdown state once more so
    // `breaker`/`stopFileSeen` surface truthfully. Best-effort: obs.heartbeat already
    // swallows, and the extra `.catch` guarantees drain/lock-release still proceed.
    await obs
      .heartbeat({
        workerTarget: 0,
        slotsBusy: inflight.size,
        queueDepth: 0,
        inFlight: [...inFlightMeta.values()],
        breaker: breakerSnapshot(),
        stopFileSeen: killed(),
      })
      .catch(() => undefined);
  } finally {
    rmSync(LOCK, { force: true });
    log("foreman stopped");
  }
}

// Force process termination once the control loop ends: the Prisma client holds
// open connections that otherwise keep the event loop alive, so an armed run
// would never exit after a clean shutdown. The lock is already released and
// "foreman stopped" logged inside main()'s finally before we get here.
main()
  .then(() => process.exit(0))
  .catch((e) => {
    log(`fatal: ${String(e)}`);
    process.exit(1);
  });
