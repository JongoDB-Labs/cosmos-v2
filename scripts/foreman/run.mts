// Foreman orchestrator: the control loop that wires the ten foreman modules into
// one autonomous-delivery daemon. It reads the COSMOS backlog and, for each ready
// ticket, runs the pipeline — dedup gate -> clarity gate -> coding agent -> checks
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
import { existsSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pickNext } from "@/lib/foreman/queue";
import { classifyRisk } from "@/lib/foreman/risk";
import { foremanPrompt, type TicketBrief } from "@/lib/foreman/prompt";
import { dedupGate, ledgerCandidates } from "@/lib/foreman/dedup-gate";
import { appendLedger, readLedger, type LedgerEntry } from "@/lib/foreman/ledger";
import type { Candidate } from "@/lib/foreman/dedup";
import * as db from "./db.mjs";
import { runAgent } from "./agent.mjs";
import { runChecks, diffSummary } from "./checks.mjs";
import * as ship from "./ship.mjs";

const exec = promisify(execFile);

const REPO = "/home/defcon/cosmos-v2";
const LEDGER = join(REPO, ".deploy/foreman-ledger.jsonl");
const STOP = join(REPO, ".deploy/FOREMAN_STOP");
const LOCK = join(REPO, ".deploy/FOREMAN_LOCK");
const LOG = "/var/log/cosmos-foreman.log";
const DRY = process.env.FOREMAN_DRY_RUN === "1";

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
  const r = await runAgent(REPO, prompt, { maxTurns: 2, timeoutMs: 120_000 });
  // Honor the LAST verdict line, anchored to the line start: a hedged mid-sentence
  // "... this is NOT a DUP COSMOS-1 ..." can't register as a duplicate (it doesn't
  // start with "DUP "), and a trailing "UNIQUE:" overrides an earlier "DUP".
  // Parse failure (no verdict line at all) defaults to unique. (M1)
  let verdict: { dupOf: string | null; reason: string } = { dupOf: null, reason: "unique" };
  for (const raw of r.log.split("\n")) {
    const line = raw.trim();
    const dup = line.match(/^DUP\s+(COSMOS-\d+)\s*:\s*(.*)$/);
    if (dup) {
      verdict = { dupOf: dup[1], reason: dup[2].trim() || "duplicate" };
      continue;
    }
    if (/^UNIQUE\b/.test(line)) verdict = { dupOf: null, reason: line.replace(/^UNIQUE\s*:?\s*/, "").trim() || "unique" };
  }
  return verdict;
}

/** Clarity gate (§5.6): can this be built correctly without a product/scope
 *  decision the author must make? A cheap subscription judgment — never guess & ship. */
async function clarityCheck(brief: TicketBrief): Promise<{ needsInput: boolean; question: string }> {
  const criteria = brief.acceptanceCriteria[0]
    ? brief.acceptanceCriteria.map((c) => "- " + c).join("\n")
    : "(none)";
  const prompt = `A ticket to implement:\nTitle: ${brief.title}\nDescription: ${brief.description || "(none)"}\nAcceptance criteria:\n${criteria}\n\nCan a competent engineer implement this CORRECTLY from what's written, WITHOUT a product/scope/UX/business decision that only the author can make (e.g. which metrics, what layout, a business rule, a missing credential, an ambiguous "which one")? Reply exactly "OK" if yes, or "NEEDS_INPUT: <the single most important question to unblock it>" if not.`;
  const r = await runAgent(REPO, prompt, { maxTurns: 2, timeoutMs: 120_000 });
  const m = r.log.match(/NEEDS_INPUT:\s*(.+)/);
  return m ? { needsInput: true, question: m[1].trim() } : { needsInput: false, question: "" };
}

function briefFrom(t: Awaited<ReturnType<typeof db.getBacklog>>[number]): TicketBrief {
  const tri = (t.triage ?? {}) as Record<string, unknown>;
  const classification: "BUG" | "FEATURE" = tri.classification === "FEATURE" ? "FEATURE" : "BUG";
  const rawCriteria = tri.acceptanceCriteria;
  return {
    key: `COSMOS-${t.ticketNumber}`,
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

async function processOne(item: Awaited<ReturnType<typeof db.getBacklog>>[number]): Promise<void> {
  const brief = briefFrom(item);
  const key = brief.key;
  const record = (e: Omit<LedgerEntry, "ts">): void =>
    appendLedger(LEDGER, { ...e, ts: new Date().toISOString() });

  // Dedup gate FIRST — don't spin a worktree for something already known.
  const candidates = [...ledgerCandidates(readLedger(LEDGER)), ...(await db.historyCandidates())];
  const dup = await dedupGate({ title: brief.title, candidates }, judge);
  if (dup.dupOf) {
    log(`${key} duplicate of ${dup.dupOf} — ${dup.reason}`);
    if (!DRY) {
      await db.moveColumn(item.id, "done");
      await db.addTag(item.id, "duplicate");
      await db.comment(item.id, `Resolved as duplicate of ${dup.dupOf}. ${dup.reason}`);
    }
    record({ ticket: key, title: brief.title, classification: brief.classification, resolution: "duplicate", dupOf: dup.dupOf });
    return;
  }

  // Clarity gate — does this need a product/scope decision Foreman can't make? (§5.6)
  const clar = await clarityCheck(brief);
  if (clar.needsInput) {
    log(`${key} needs input — ${clar.question}`);
    if (!DRY) {
      await db.moveColumn(item.id, "review");
      await db.addTag(item.id, "needs-input");
      await db.comment(item.id, `❓ Needs your input before I can build this: ${clar.question}\n\nAnswer in the description/comments and move the card back to Backlog to re-queue.`);
    }
    record({ ticket: key, title: brief.title, classification: brief.classification, resolution: "needs-input" });
    return;
  }

  if (!DRY) await db.moveColumn(item.id, "in-progress");
  const branch = `auto/${key}`;
  const wt = `/tmp/foreman/${key}`;
  await exec("git", ["-C", REPO, "fetch", "origin", "main"]);
  await exec("git", ["-C", REPO, "worktree", "add", "-B", branch, wt, "origin/main"]);
  try {
    const agent = await runAgent(wt, foremanPrompt(brief));

    // (a) Agent infra-failure (timeout, spawn error, or non-zero exit → agent.ok
    //     false, usually with no commit). Gate for review — NEVER conflate this
    //     with "already done" and auto-close a build that actually failed. (I2)
    if (!agent.ok) {
      log(`${key} GATED (agent did not complete) → In Review`);
      if (!DRY) {
        await db.moveColumn(item.id, "review");
        await db.comment(item.id, `Needs review — agent did not complete (timeout, spawn error, or non-zero exit); no automated build produced. Last output:\n\n${agent.log.slice(-1000).trim() || "(no output)"}`);
      }
      record({ ticket: key, title: brief.title, classification: brief.classification, resolution: "gated" });
      return;
    }

    // (b) Agent completed. A truly empty diff means it was already implemented —
    //     regardless of checks — so there's nothing to build OR ship. This also
    //     stops an empty diff from falling through to mergeBranch's
    //     `commit --no-edit`, which would fail on nothing-to-commit. (I2)
    const diff = await diffSummary(wt);
    if (diff.files.length === 0) {
      log(`${key} already implemented (empty diff)`);
      if (!DRY) {
        await db.moveColumn(item.id, "done");
        await db.addTag(item.id, "already-done");
        await db.comment(item.id, "Already implemented — no change produced.");
      }
      record({ ticket: key, title: brief.title, classification: brief.classification, resolution: "already-done" });
      return;
    }

    // (c) Real change → run checks + classify risk → gate-or-ship.
    const checks = await runChecks(wt);
    const risk = classifyRisk(diff);
    if (!checks.ok || risk.gated) {
      const reason = !checks.ok ? "checks failed" : risk.reasons.join("; ");
      log(`${key} GATED (${reason}) → In Review`);
      if (!DRY) {
        await exec("git", ["-C", wt, "push", "-u", "origin", branch]);
        await exec(
          "gh",
          ["pr", "create", "--draft", "--base", "main", "--head", branch, "--title", `auto: ${key} (review — ${reason})`, "--body", `Automated draft for ${key}. Reason parked: ${reason}. Approve = merge; Foreman deploys on its next pass.`],
          { cwd: REPO },
        );
        await db.moveColumn(item.id, "review");
        await db.comment(item.id, `Needs review — ${reason}. Draft PR opened.`);
      }
      record({ ticket: key, title: brief.title, classification: brief.classification, resolution: "gated" });
      return;
    }

    // SAFE → ship. The agent already bumped package.json per the SemVer rule.
    const version = ship.readVersion(wt);
    log(`${key} SAFE → shipping v${version}${DRY ? " (DRY)" : ""}`);
    if (DRY) {
      record({ ticket: key, title: brief.title, classification: brief.classification, resolution: "shipped", version });
      return;
    }

    // Merge -> tag -> wait for the signed image. Any throw here — a squash-merge
    // CONFLICT because main moved under us, a tag/push race, or a failed image
    // build — must NOT crash the daemon or leave the shared checkout mid-merge.
    // Restore main to origin, gate the ticket for review, and move on. (plan §13)
    try {
      await ship.mergeBranch(branch);
      await ship.tagAndPush(version);
      if (!(await ship.waitForImage(version))) throw new Error("image build failed");
    } catch (e) {
      log(`${key} ship failed before deploy (${String(e)}) → In Review`);
      await restoreMain();
      await db.moveColumn(item.id, "review");
      await db.comment(item.id, `Ship failed before deploy: ${String(e)}. Restored main and parked for review.`);
      record({ ticket: key, title: brief.title, classification: brief.classification, resolution: "gated" });
      return;
    }

    // Image built → deploy. deploy() never throws; its boolean IS the health gate.
    const ok = await ship.deploy(version, diff.files.some((f) => f.startsWith("prisma/migrations/")));
    if (ok) {
      await db.moveColumn(item.id, "done");
      await db.comment(item.id, `Shipped v${version}.`);
      record({ ticket: key, title: brief.title, classification: brief.classification, resolution: "shipped", version });
      log(`${key} DONE v${version}`);
    } else {
      // Deploy health-gate failed. Roll back + park for review as best-effort, but
      // guarantee the circuit-breaker signal fires REGARDLESS: a DB blip in the
      // cleanup below must not swallow a real deploy failure and leave it
      // uncounted (which would keep an unhealthy release armed). (M4)
      try {
        const prev = readLedger(LEDGER).filter((e) => e.version).pop()?.version;
        if (prev) await ship.rollback(prev);
        await db.moveColumn(item.id, "review");
        await db.comment(item.id, `Deploy health-gate failed; rolled back. Parked for review.`);
        record({ ticket: key, title: brief.title, classification: brief.classification, resolution: "gated" });
      } catch (e) {
        log(`${key} deploy-gate cleanup error (continuing to circuit breaker): ${String(e)}`);
      }
      // Signal the circuit breaker in main(): repeated deploy-gate failures disarm.
      throw new Error("deploy gate failed (rolled back)");
    }
  } finally {
    await exec("git", ["-C", REPO, "worktree", "remove", "--force", wt]).catch(() => undefined);
    // Armed-only last-resort: never leave the shared checkout on a foreign or
    // dirty branch after a ship, whatever escaped above. DRY never moves REPO off
    // main (it returns before mergeBranch), so skip the force-checkout there to
    // keep dry-runs side-effect-free on the working checkout.
    if (!DRY) await exec("git", ["-C", REPO, "checkout", "-f", "main"]).catch(() => undefined);
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
  let consecutiveDeployFails = 0;
  // DRY surveys each backlog ticket exactly once: terminal column moves are
  // skipped in DRY, so without this the picked ticket stays in `backlog` and the
  // loop would re-process the same top-priority one forever. (I1)
  const processed = new Set<string>();
  try {
    while (!killed()) {
      try {
        if (!(await db.autonomyEnabled())) {
          log("autonomy disabled — idle");
          await idleSleep(60_000);
          continue;
        }
        const backlog = await db.getBacklog();
        const pool = DRY ? backlog.filter((b) => !processed.has(b.id)) : backlog;
        const next = pickNext(pool);
        if (!next) {
          await idleSleep(60_000);
          continue;
        }
        const item = backlog.find((b) => b.id === next.id);
        if (!item) continue;
        try {
          await processOne(item);
          consecutiveDeployFails = 0;
        } catch (e) {
          log(`${next.id} error: ${String(e)}`);
          if (String(e).includes("deploy gate")) {
            if (++consecutiveDeployFails >= 2) {
              log("circuit breaker: 2 deploy failures — disabling");
              writeFileSync(STOP, "circuit-breaker");
            }
          }
        }
        // Advance the DRY survey regardless of outcome so it walks the whole
        // backlog once, then idles (armed runs advance via real column moves).
        if (DRY) processed.add(item.id);
      } catch (e) {
        // Control-plane hiccup (e.g. a transient DB error in autonomyEnabled /
        // getBacklog): log and idle rather than tearing the daemon down.
        log(`control-loop error: ${String(e)} — idling`);
        await idleSleep(30_000);
      }
      if (killed()) break;
    }
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
