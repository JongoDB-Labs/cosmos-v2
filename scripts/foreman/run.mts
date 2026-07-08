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
import { existsSync, writeFileSync, rmSync, appendFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pickNext } from "@/lib/foreman/queue";
import { classifyRisk } from "@/lib/foreman/risk";
import { foremanPrompt, type TicketBrief } from "@/lib/foreman/prompt";
import { dedupGate, ledgerCandidates } from "@/lib/foreman/dedup-gate";
import { appendLedger, readLedger, type LedgerEntry } from "@/lib/foreman/ledger";
import { pendingGated } from "@/lib/foreman/reconcile";
import type { Candidate } from "@/lib/foreman/dedup";
import { compareVersions } from "@/lib/changelog";
import * as db from "./db.mjs";
import { runAgent } from "./agent.mjs";
import { runChecks, diffSummary } from "./checks.mjs";
import * as ship from "./ship.mjs";

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
    const agent = await runAgent(wt, foremanPrompt(brief));
    if (await haltIfKilled()) return; // checkpoint 1: right after the agent returns

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

    if (await haltIfKilled()) return; // checkpoint 2: before the irreversible merge

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

    if (await haltIfKilled()) return; // checkpoint 3: before pushing the deploy to prod

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
        // Roll back the version we JUST deployed by restoring its pre-deploy
        // `.bak-<version>` override — NOT a prevVersion from the ledger (empty on
        // the first ship, and stale otherwise). rollback() no-ops if the snapshot
        // is missing; the breaker still fires via the throw below. (C1)
        await ship.rollback(version);
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

/** Reconcile approved (merged) gated tickets. When Foreman gates a risky change it
 *  opens a DRAFT PR on `auto/COSMOS-<n>` and parks the ticket in `review`; a human
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
      const n = parseInt(ref.replace("COSMOS-", ""), 10);
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

      const item = await db.resolveTicket(n);
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
          attempts.delete(item.id);
        } catch (e) {
          log(`${next.id} error: ${String(e)}`);
          if (String(e).includes("deploy gate")) {
            if (++consecutiveDeployFails >= 2) {
              log("circuit breaker: 2 deploy failures — disabling");
              writeFileSync(STOP, "circuit-breaker");
            }
          }
          const n = (attempts.get(item.id) ?? 0) + 1;
          attempts.set(item.id, n);
          if (n >= MAX_ATTEMPTS && !DRY) {
            // Repeatedly failing on the SAME ticket → stop retrying it. Park it out
            // of `backlog` (into review) so pickNext moves on and the daemon makes
            // progress instead of hot-looping this one id. (I4)
            log(`${next.id} failed ${n}× — parking for review so the loop can progress`);
            await db.moveColumn(item.id, "review").catch(() => undefined);
            await db
              .comment(item.id, `Repeatedly failed to process (${n} attempts) — needs a human. Last error: ${String(e)}`)
              .catch(() => undefined);
          }
          // Bounded, kill-responsive backoff so an early-throwing ticket can't peg
          // the CPU or balloon the log; `touch FOREMAN_STOP` still exits promptly. (I4)
          await idleSleep(30_000);
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
