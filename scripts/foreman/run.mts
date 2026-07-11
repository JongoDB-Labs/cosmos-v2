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
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pickNext } from "@/lib/foreman/queue";
import { classifyRisk } from "@/lib/foreman/risk";
import { formatAudit, tailLog } from "@/lib/foreman/audit";
import { foremanPrompt, repairPrompt, type TicketBrief } from "@/lib/foreman/prompt";
import { reviewerPrompt, parseReviewVerdict, type ReviewDiff } from "@/lib/foreman/review";
import { nextVersion, extractTopChangelogEntry, prependChangelogEntry, conflictsAreMechanical, type BumpKind } from "@/lib/foreman/ship-rebase";
import { replyPrompt } from "@/lib/foreman/mention";
import { dedupGate, ledgerCandidates } from "@/lib/foreman/dedup-gate";
import { appendLedger, readLedger, type LedgerEntry } from "@/lib/foreman/ledger";
import { pendingGated } from "@/lib/foreman/reconcile";
import { buildRef, parseRef } from "@/lib/foreman/ref";
import type { Candidate } from "@/lib/foreman/dedup";
import { compareVersions } from "@/lib/changelog";
import * as db from "./db.mjs";
import { runAgent } from "./agent.mjs";
import { runChecks, diffSummary } from "./checks.mjs";
import * as ship from "./ship.mjs";
import { ensureWorkerDbs } from "./worker-db.mjs";

const exec = promisify(execFile);

const REPO = "/home/defcon/cosmos-v2";
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
): Promise<{ dupOf: string | null; reason: string }> {
  const list = shortlist.map((c) => `${c.ref}: ${c.title}`).join("\n");
  const prompt = `Ticket: "${title}". Already-known items:\n${list}\nIs the ticket the SAME underlying request as one of them? Reply exactly "DUP <ref>: <reason>" or "UNIQUE: <reason>".`;
  // Read-only tools + scratch cwd (not REPO): this judge reasons over untrusted
  // ticket/feedback text, so it must not be able to shell out or edit the repo. (I3)
  const r = await runAgent(SCRATCH, prompt, { maxTurns: 2, timeoutMs: 120_000, allowedTools: "Read,Grep,Glob" });
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
async function clarityCheck(brief: TicketBrief, instructions: string[] = []): Promise<{ needsInput: boolean; question: string }> {
  const criteria = brief.acceptanceCriteria[0]
    ? brief.acceptanceCriteria.map((c) => "- " + c).join("\n")
    : "(none)";
  const guidance = instructions.length
    ? `\nMaintainer instructions already provided in the ticket's comments (treat these as authoritative answers):\n${instructions.map((i) => "- " + i).join("\n")}\n`
    : "";
  const prompt = `A ticket to implement:\nTitle: ${brief.title}\nDescription: ${brief.description || "(none)"}\nAcceptance criteria:\n${criteria}\n${guidance}\nCan a competent engineer implement this CORRECTLY from what's written, WITHOUT a product/scope/UX/business decision that only the author can make (e.g. which metrics, what layout, a business rule, a missing credential, an ambiguous "which one")? Reply exactly "OK" if yes, or "NEEDS_INPUT: <the single most important question to unblock it>" if not.`;
  // Read-only tools + scratch cwd (not REPO): same untrusted-input reasoning as the
  // dedup judge — no shell, no repo writes. (I3)
  const r = await runAgent(SCRATCH, prompt, { maxTurns: 2, timeoutMs: 120_000, allowedTools: "Read,Grep,Glob" });
  const m = r.log.match(/NEEDS_INPUT:\s*(.+)/);
  return m ? { needsInput: true, question: m[1].trim() } : { needsInput: false, question: "" };
}

function briefFrom(t: Awaited<ReturnType<typeof db.getBacklog>>[number]): TicketBrief {
  const tri = (t.triage ?? {}) as Record<string, unknown>;
  const classification: "BUG" | "FEATURE" = tri.classification === "FEATURE" ? "FEATURE" : "BUG";
  const rawCriteria = tri.acceptanceCriteria;
  return {
    key: buildRef(t.projectKey, t.ticketNumber),
    title: t.title,
    description: t.description,
    classification,
    acceptanceCriteria: Array.isArray(rawCriteria)
      ? rawCriteria.filter((x: unknown): x is string => typeof x === "string")
      : [],
  };
}

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
  subject: string;
  commit: string;
  processNote: string;
  changelogEntry: string | null;
  bumpKind: BumpKind;
}

async function processOne(
  item: Awaited<ReturnType<typeof db.getBacklog>>[number],
  workerOpts: { testDbUrl?: string } = {},
): Promise<{ ship?: Built }> {
  const brief = briefFrom(item);
  const key = brief.key;
  // DRY records to the .dry ledger so a preview never pollutes the real history
  // (which would seed the next armed run's dedup). (I5)
  const record = (e: Omit<LedgerEntry, "ts">): void =>
    appendLedger(DRY ? LEDGER_DRY : LEDGER, { ...e, ts: new Date().toISOString() });

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
  const dup = await dedupGate({ title: brief.title, candidates }, judge);
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
  const clar = await clarityCheck(brief, instructions);
  if (clar.needsInput) {
    log(`${key} needs input — ${clar.question}`);
    if (!DRY) {
      await db.moveColumn(item.id, "review");
      await db.addTag(item.id, "needs-input");
      await db.comment(item.id, `❓ Needs your input before I can build this: ${clar.question}\n\nAnswer in the description/comments and move the card back to Backlog to re-queue.`);
      await db.notifyDelivery(item.id, "parked", { key, title: brief.title, reason: `needs input — ${clar.question}` });
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
    const agent = await runAgent(wt, foremanPrompt(brief, instructions), { testDbUrl: workerOpts.testDbUrl });
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
    let checks = await runChecks(wt, { testDbUrl: workerOpts.testDbUrl });
    let repairs = 0;
    while (!checks.ok && repairs < MAX_REPAIRS) {
      if (await haltIfKilled()) return {}; // never keep building past a kill
      repairs++;
      log(`${key} checks failed — repair round ${repairs}/${MAX_REPAIRS}`);
      const rep = await runAgent(wt, repairPrompt(key, tailLog(checks.log, 3000)), {
        resume: agent.sessionId ?? undefined,
        timeoutMs: 25 * 60_000,
        testDbUrl: workerOpts.testDbUrl,
      });
      if (!rep.ok) {
        log(`${key} repair agent did not complete — gating with the last check output`);
        break;
      }
      checks = await runChecks(wt, { testDbUrl: workerOpts.testDbUrl });
    }
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
      if (!DRY) {
        await ship.pushBranch(branch);
        const prUrl = await ship.openPr(
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
      if (!DRY) await db.notifyDelivery(item.id, "parked", { key, title: brief.title, reason, version });
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
    // path). The diff is written inside .git/ so it can never enter the change
    // itself. Fail-closed: an unreadable/failed reviewer parks the ticket — a
    // ship gate that can't run must not open. One retry absorbs infra flakes.
    const { stdout: diffText } = await exec("git", ["-C", wt, "diff", "origin/main...HEAD"], {
      maxBuffer: 32 * 1024 * 1024,
    });
    // Inline the diff for the normal case (SAFE ⇒ ≤400 changed lines, fits the
    // prompt; zero file access needed). The oversized fallback writes into the
    // REAL git dir — resolved via rev-parse, because in a linked worktree `.git`
    // is a FILE pointing at <repo>/.git/worktrees/<KEY>, so joining ".git/x"
    // throws ENOTDIR (this exact bug crashed the first three reviews live).
    let reviewDiff: ReviewDiff;
    if (diffText.length <= 200_000) {
      reviewDiff = { kind: "inline", text: diffText };
    } else {
      const { stdout: gitDir } = await exec("git", ["-C", wt, "rev-parse", "--absolute-git-dir"]);
      const diffFile = join(gitDir.trim(), "FOREMAN_REVIEW.diff");
      writeFileSync(diffFile, diffText);
      reviewDiff = { kind: "file", path: diffFile };
    }
    const reviewOpts = { allowedTools: "Read,Grep,Glob", maxTurns: 30, timeoutMs: 15 * 60_000 };
    let review = await runAgent(wt, reviewerPrompt(brief, reviewDiff), reviewOpts);
    if (!review.ok) review = await runAgent(wt, reviewerPrompt(brief, reviewDiff), reviewOpts);
    const verdict = review.ok
      ? parseReviewVerdict(review.log)
      : { approve: false, reason: "reviewer agent failed twice (infra)" };
    if (!verdict.approve) {
      await parkForReview(`reviewer rejected — ${verdict.reason}`);
      return {};
    }
    processParts.push(`reviewer approved — ${verdict.reason}`);
    const processNote = processParts.join(" · ");

    // SAFE → hand off to the serialized SHIP worker. The agent bumped from the
    // main it branched off; ship re-bumps after rebasing onto CURRENT main.
    log(`${key} SAFE → queued for ship (built v${version})${DRY ? " (DRY)" : ""}`);
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
  const record = (e: Omit<LedgerEntry, "ts">): void =>
    appendLedger(LEDGER, { ...e, ts: new Date().toISOString() });
  const parkShip = async (reason: string): Promise<void> => {
    log(`${b.key} SHIP PARKED (${reason}) → In Review`);
    await ship.pushBranch(b.branch).catch(() => undefined);
    let prUrl = "";
    try {
      prUrl = await ship.openPr(
        b.branch,
        `auto: ${b.key} (review — ${reason})`.slice(0, 250),
        `Automated draft for ${b.key}. Reason parked: ${reason}. Approve = merge; Foreman deploys it on its next pass.`,
        true,
      );
    } catch {
      /* PR may already exist from the build phase */
    }
    await db.moveColumn(b.itemId, "review");
    await db.comment(
      b.itemId,
      formatAudit({ key: b.key, outcome: "review", summary: b.subject, reason, branch: b.branch, commit: b.commit, prUrl: prUrl || undefined, process: b.processNote }),
    );
    record({ ticket: b.key, title: b.title, classification: b.classification, resolution: "gated" });
    await db.notifyDelivery(b.itemId, "parked", { key: b.key, title: b.title, reason, prUrl: prUrl || undefined });
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

    let prUrl = "";
    let merged = false;
    let mergedCommit = "";
    try {
      await ship.pushBranch(b.branch);
      prUrl = await ship.openPr(
        b.branch,
        `auto: ${b.key} — ${b.title}`.slice(0, 250),
        `Automated fix for ${b.key} (v${version}). Auto-merged by Foreman after green checks.`,
        false,
      );
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
    } catch (cleanupErr) {
      log(`${b.key} deploy-gate cleanup error (continuing to circuit breaker): ${String(cleanupErr)}`);
    }
    return { deployFailed: true };
  } finally {
    await exec("git", ["-C", REPO, "worktree", "remove", "--force", b.wt]).catch(() => undefined);
    await exec("git", ["-C", REPO, "checkout", "-f", "main"]).catch(() => undefined);
  }
}

/** @Foreman mention processor — the ticket-comment channel (§ agent identity).
 *  Each pass: find privileged mentions not yet consumed (db.freshMentions), then
 *  - ticket in `review` (parked / needs-input): REQUEUE it to the backlog with an
 *    ack comment — the instruction itself is picked up by instructionsFor() at
 *    build time, so the rebuild follows it. moveColumn resets columnEnteredAt,
 *    which is the watermark, so a mention is consumed exactly once.
 *  - any other column: REPLY in-thread via a read-only agent (Read/Grep/Glob in
 *    the repo — code-grounded answers, no shell, no edits) + ping the asker. The
 *    bot's reply timestamp is that path's watermark.
 *  Mentions by non-privileged members are filtered in db.freshMentions. Never
 *  throws — a mention hiccup must not stall delivery. */
async function processMentions(): Promise<void> {
  let fresh: Awaited<ReturnType<typeof db.freshMentions>>;
  try {
    fresh = await db.freshMentions();
  } catch (e) {
    log(`mention scan failed (${String(e)}) — skipping this pass`);
    return;
  }
  for (const m of fresh) {
    try {
      if (killed()) return;
      if (m.columnKey === "review") {
        log(`${m.key} @Foreman instruction on parked ticket — requeueing`);
        await db.moveColumn(m.itemId, "backlog");
        await db.comment(
          m.itemId,
          `Got it — requeued with your instructions. I'll rebuild ${m.key} accordingly on my next pass.`,
        );
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
          { allowedTools: "Read,Grep,Glob", maxTurns: 15, timeoutMs: 5 * 60_000 },
        );
        const reply = r.ok && r.log.trim() ? r.log.trim().slice(-2000) : "";
        if (!reply) {
          log(`${m.key} reply agent failed — leaving the mention for the next pass`);
          continue;
        }
        await db.comment(m.itemId, reply);
        await db.notifyReply(m.itemId, m.askerUserId, m.key, reply);
      }
    } catch (e) {
      log(`${m.key} mention handling failed (${String(e)}) — continuing`);
    }
  }
}

/** Reconcile approved (merged) gated tickets. When Foreman gates a risky change it
 *  opens a DRAFT PR on `auto/<KEY>-<n>` and parks the ticket in `review`; a human
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
    if (reclaimed.length > 0) log(`reclaimed ${reclaimed.length} stranded in-progress → backlog: ${reclaimed.join(", ")}`);
    // Snap every linked feedback status back to its ticket's actual column —
    // heals any drift from paths that bypassed the live sync (see db.mts).
    const resynced = await db.resyncFeedbackTruth().catch(() => 0);
    if (resynced > 0) log(`feedback ground-truth resync over ${resynced} linked items`);
  }
  let consecutiveDeployFails = 0;
  // Reconcile gets its OWN deploy-failure breaker, independent of the shared
  // consecutiveDeployFails above: otherwise an unrelated backlog ticket shipping
  // between two reconcile attempts would reset that shared counter, so a
  // persistently-broken approved deploy would retry (real deploy+rollback churn)
  // forever without ever tripping. Same threshold + halt action. (I3)
  let reconcileDeployFails = 0;
  const BREAKER = 2;
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
      .then(() => shipBuilt(b))
      .then((r) => {
        if (r.deployFailed) {
          if (++consecutiveDeployFails >= BREAKER) {
            log("circuit breaker: 2 deploy failures — disabling");
            writeFileSync(STOP, "circuit-breaker");
          }
        } else {
          consecutiveDeployFails = 0;
        }
      })
      .catch((e) => log(`${b.key} ship worker error: ${String(e)}`));
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
            }
          } else {
            log(`reconcile skipped: ${String(e)}`); // transient gh/git/db — not a deploy failure
          }
        }
        if (killed()) continue; // breaker may have just fired — don't start a build

        // @Foreman mentions: requeue instructed parked tickets + answer questions
        // BEFORE picking new work — a maintainer's instruction outranks the queue.
        // Never in DRY (it comments + moves cards on the live board).
        if (!DRY) await processMentions();
        if (killed()) continue;
        // ── fill build slots, then pump on any completion ──
        const backlog = await db.getBacklog();
        const pool = DRY ? backlog.filter((b) => !processed.has(b.id)) : backlog;
        // LIVE target from org settings (clamped by provisioning + env cap).
        const workerTarget = DRY ? 1 : Math.min(slotCap, await db.deliveryWorkerTarget().catch(() => 1));
        while (inflight.size < workerTarget && freeSlots.length > 0 && !killed()) {
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
          const task = (async () => {
            try {
              const out = await processOne(item, { testDbUrl: workerDbUrls[slot] });
              attempts.delete(item.id);
              if (out.ship) enqueueShip(out.ship);
            } catch (e) {
              log(`${item.id} error: ${String(e)}`);
              const n = (attempts.get(item.id) ?? 0) + 1;
              attempts.set(item.id, n);
              if (n >= MAX_ATTEMPTS && !DRY) {
                log(`${item.id} failed ${n}× — parking for review so the loop can progress`);
                await db.moveColumn(item.id, "review").catch(() => undefined);
                await db
                  .comment(item.id, `Repeatedly failed to process (${n} attempts) — needs a human. Last error: ${String(e)}`)
                  .catch(() => undefined);
              }
              await idleSleep(30_000); // bounded backoff without hot-looping the slot
            } finally {
              inflight.delete(item.id);
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
