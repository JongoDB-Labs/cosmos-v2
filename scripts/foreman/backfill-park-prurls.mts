// One-time (idempotent) backfill: legacy parked-review Foreman events —
// recorded before v2.198.0, when a `parked`/`gated`/etc. event's `data` didn't
// carry `prUrl` — leave the console's Approve button disabled even though a
// draft PR exists (status-read.ts gates Approve on the latest parked-kind
// event's `data.prUrl`). Every such PR lives on the daemon's own branch
// convention, `auto/<KEY>` (see src/lib/foreman/ref.ts buildRef + run.mts's
// ship path), so it can be resolved with `gh pr view` and patched back onto
// the event that needs it. Safe to re-run: latestParkNeedingPr (the pure
// selection half, src/lib/foreman/backfill-park-prurls.ts) skips any item
// whose latest parked-kind event already carries a prUrl.
//
//   DATABASE_URL=postgresql://… npx tsx scripts/foreman/backfill-park-prurls.mts [--dry]
//
// --dry prints every intended patch without writing.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { deliveryProjects } from "./db.mjs";
import { PARKED_EVENT_KINDS } from "@/lib/foreman/observe";
import { buildRef } from "@/lib/foreman/ref";
import { latestParkNeedingPr } from "@/lib/foreman/backfill-park-prurls";

const exec = promisify(execFile);

// Unlike run.mts/ship.mts (the daemon, always pinned to REPO="/home/defcon/
// cosmos-v2"), this is a standalone operator script with no fixed checkout —
// it's run by hand from whatever git working copy has the GitHub remote (a
// dev worktree, or the host checkout), so `gh` is shelled out with no
// explicit cwd and resolves the repo from wherever the process already is.
async function prUrlFor(branch: string): Promise<string | null> {
  try {
    const { stdout } = await exec("gh", ["pr", "view", branch, "--json", "url,state"]);
    const url = (JSON.parse(stdout) as { url?: string }).url;
    return url && url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");

  const pool = await deliveryProjects();
  if (pool.length === 0) {
    console.log("no delivery-pool projects — nothing to backfill");
    process.exit(0);
  }
  const orgIds = [...new Set(pool.map((p) => p.orgId))];

  let patched = 0;
  let noPr = 0;
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
      orderBy: { ts: "desc" },
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
      const prUrl = await prUrlFor(branch);
      if (!prUrl) {
        console.log(`${ref}: no PR found — skipped`);
        noPr++;
        continue;
      }

      if (dry) {
        console.log(`[dry] ${ref}: patched prUrl ${prUrl}`);
        patched++;
        continue;
      }

      await prisma.foremanEvent.update({
        where: { id: candidate.id },
        data: { data: { ...candidate.data, prUrl, branch } as Prisma.InputJsonValue },
      });
      console.log(`${ref}: patched prUrl ${prUrl}`);
      patched++;
    }
  }

  console.log(
    `${dry ? "[dry] " : ""}done — patched ${patched}, no PR found ${noPr}, already had prUrl ${alreadyHad}, no park history ${noParkHistory}`,
  );
  process.exit(0);
}

if (process.argv[1]?.endsWith("backfill-park-prurls.mts")) void main();
