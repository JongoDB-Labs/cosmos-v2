// One-time (idempotent) backfill: legacy parked-review Foreman events —
// recorded before v2.198.0, when a `parked`/`gated`/etc. event's `data` didn't
// carry `prUrl` — leave the console's Approve button disabled even though a
// draft PR exists. status-read.ts gates Approve on the event observe.pickParkEvent
// surfaces — the newest REASONED park (the same event this script patches), NOT
// merely the newest parked-kind event — so patching any other event would log a
// false "patched" while the console keeps reading (and Approve stays dark on) the
// one it actually shows. Every such PR lives on the daemon's own branch
// convention, `auto/<KEY>` (see src/lib/foreman/ref.ts buildRef + run.mts's ship
// path), so it can be resolved with `gh pr view` and patched back onto that
// event. Safe to re-run: latestParkNeedingPr (the pure selection half,
// src/lib/foreman/backfill-park-prurls.ts) skips any item whose surfaced park
// event already carries a prUrl.
//
//   DATABASE_URL=postgresql://… npx tsx scripts/foreman/backfill-park-prurls.mts [--dry]
//
// --dry prints every intended patch (with the resolved PR state) without writing.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { deliveryProjects } from "./db.mjs";
import { PARKED_EVENT_KINDS } from "@/lib/foreman/observe";
import { buildRef } from "@/lib/foreman/ref";
import { decidePrBackfill, latestParkNeedingPr } from "@/lib/foreman/backfill-park-prurls";

const exec = promisify(execFile);

// The repo checkout to shell `gh`/`git` against, PINNED to a cwd rather than left
// to inherit the operator's shell dir — an unpinned cwd let `gh` fail to find the
// repo/remote and every lookup collapse into a misleading "no PR found". Derived
// from this module's own location (scripts/foreman/ → repo root) so it also works
// from a dev worktree, instead of run.mts/ship.mts's hardcoded REPO constant.
const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** First non-empty stderr line of a failed `exec` (falling back to its message),
 *  for a one-line log. */
function stderrOf(e: unknown): string {
  const err = e as { stderr?: unknown; message?: string };
  const s = err.stderr != null ? String(err.stderr).trim() : "";
  return s.length > 0 ? s : (err.message ?? String(e));
}
function firstLine(s: string): string {
  return s.split("\n")[0]?.trim() ?? s;
}

type PrLookup =
  | { ok: true; url: string | null; state: string | null }
  | { ok: false; message: string };

/** Resolve the PR on `branch` via `gh` (pinned to REPO). Distinguishes the
 *  ordinary "this branch has no PR" case — `gh` exits non-zero with "no pull
 *  requests found …", folded into a url-less success the caller skips — from a
 *  genuine environment failure (auth expired, rate limit, network), which is
 *  surfaced so a mid-run breakage is VISIBLE instead of masquerading as "nothing
 *  to backfill". */
async function lookupPr(branch: string): Promise<PrLookup> {
  try {
    const { stdout } = await exec("gh", ["pr", "view", branch, "--json", "url,state"], { cwd: REPO });
    const parsed = JSON.parse(stdout) as { url?: string; state?: string };
    return { ok: true, url: parsed.url ?? null, state: parsed.state ?? null };
  } catch (e) {
    const stderr = stderrOf(e);
    if (/no pull requests? found/i.test(stderr)) return { ok: true, url: null, state: null };
    return { ok: false, message: firstLine(stderr) };
  }
}

/** Fail closed before touching the DB: without a working, authenticated `gh` in a
 *  real repo checkout, every per-ticket lookup would silently skip and the whole
 *  run would read as "nothing to backfill". Read-only (writes nothing), so it runs
 *  in --dry too. */
async function preflight(): Promise<void> {
  try {
    await exec("gh", ["--version"], { cwd: REPO });
  } catch (e) {
    console.error(`preflight: gh CLI unavailable (${firstLine(stderrOf(e))}) — install GitHub CLI and retry.`);
    process.exit(1);
  }
  try {
    await exec("git", ["rev-parse", "--show-toplevel"], { cwd: REPO });
  } catch (e) {
    console.error(`preflight: ${REPO} is not a git repository (${firstLine(stderrOf(e))}) — run from the repo checkout.`);
    process.exit(1);
  }
  try {
    await exec("gh", ["auth", "status"], { cwd: REPO });
  } catch (e) {
    console.error(`preflight: gh is not authenticated (${firstLine(stderrOf(e))}) — run \`gh auth login\` and retry.`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");

  await preflight();

  const pool = await deliveryProjects();
  if (pool.length === 0) {
    console.log("no delivery-pool projects — nothing to backfill");
    process.exit(0);
  }
  const orgIds = [...new Set(pool.map((p) => p.orgId))];

  let patched = 0;
  let noPr = 0;
  let closedSkipped = 0;
  let ghFailed = 0;
  let alreadyHad = 0;
  let noParkHistory = 0;

  for (const orgId of orgIds) {
    const orgPool = pool.filter((p) => p.orgId === orgId);
    const poolByProjectId = new Map(orgPool.map((p) => [p.projectId, p]));
    const projectIds = orgPool.map((p) => p.projectId);

    const parked = await prisma.workItem.findMany({
      where: { orgId, projectId: { in: projectIds }, columnKey: "review" },
      select: { id: true, projectId: true, ticketNumber: true },
    });
    if (parked.length === 0) continue;

    const events = await prisma.foremanEvent.findMany({
      where: { workItemId: { in: parked.map((w) => w.id) }, kind: { in: [...PARKED_EVENT_KINDS] } },
      select: { id: true, workItemId: true, kind: true, ts: true, data: true },
      // ts-desc, then id-desc so exact-ms ties resolve deterministically across
      // re-runs — the same secondary order status-read.ts's query uses.
      orderBy: [{ ts: "desc" }, { id: "desc" }],
    });
    const eventsByItem = new Map<string, typeof events>();
    for (const e of events) {
      if (!e.workItemId) continue;
      const arr = eventsByItem.get(e.workItemId);
      if (arr) arr.push(e);
      else eventsByItem.set(e.workItemId, [e]);
    }

    for (const wi of parked) {
      const p = poolByProjectId.get(wi.projectId);
      if (!p) continue; // unreachable: wi.projectId came from projectIds, derived from orgPool itself
      const ref = buildRef(p.projectKey, wi.ticketNumber);

      const itemEvents = eventsByItem.get(wi.id) ?? [];
      if (itemEvents.length === 0) {
        noParkHistory++; // in review but never parked by Foreman — outside this backfill's scope
        continue;
      }

      const candidate = latestParkNeedingPr(itemEvents);
      if (!candidate) {
        console.log(`${ref}: already has prUrl — skipped`);
        alreadyHad++;
        continue;
      }

      const branch = `auto/${ref}`;
      const lookup = await lookupPr(branch);
      if (!lookup.ok) {
        console.warn(`WARN ${ref}: gh lookup failed (${lookup.message}) — skipped`);
        ghFailed++;
        continue;
      }

      const decision = decidePrBackfill(lookup);
      if (decision.kind === "no-url") {
        console.log(`${ref}: no PR found — skipped`);
        noPr++;
        continue;
      }
      if (decision.kind === "closed") {
        console.log(`${ref}: PR closed without merge — skipped (rebuild instead)`);
        closedSkipped++;
        continue;
      }

      // decision.kind === "patch" — the PR is OPEN or MERGED.
      if (dry) {
        console.log(`${ref}: would patch prUrl ${decision.url} [${decision.state}]`);
        patched++;
        continue;
      }

      await prisma.foremanEvent.update({
        where: { id: candidate.id },
        data: { data: { ...candidate.data, prUrl: decision.url, branch } as Prisma.InputJsonValue },
      });
      console.log(`${ref}: patched prUrl ${decision.url} [${decision.state}]`);
      patched++;
    }
  }

  console.log(
    `${dry ? "[dry] " : ""}done — patched ${patched}, no PR found ${noPr}, ` +
      `closed-skipped ${closedSkipped}, gh-failed ${ghFailed}, already had prUrl ${alreadyHad}, ` +
      `no park history ${noParkHistory}`,
  );
  process.exit(0);
}

if (process.argv[1]?.endsWith("backfill-park-prurls.mts")) void main();
