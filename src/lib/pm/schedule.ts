import type { Milestone, MilestoneLink, MilestoneStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";

/**
 * Schedule derivation — milestone status + completion "trickle up" from the
 * linked work items rather than being typed in by hand. Shared by the
 * milestones API, the Schedule register, and the PM Dashboard so they all agree.
 *
 * Column-key convention matches the rest of Cosmos (goals rollup, milestone
 * status): an item is "done" when its column key is `done`; `backlog`/`todo`
 * mean not-started; anything else counts as in-progress.
 */
const NOT_STARTED_COLUMNS = new Set(["backlog", "todo", "to-do"]);
const DONE_COLUMN = "done";

export type MilestoneWithLinks = Milestone & { links: MilestoneLink[] };

export interface MilestoneDerivation {
  status: MilestoneStatus;
  completedAt: Date | null;
  linkedTotal: number; // linked work items that still resolve (dangling links skipped)
  linkedDone: number;
  completionPercent: number | null; // null when no links resolve
}

/**
 * Derive a milestone's status + completion from its linked work items. When
 * `autoStatus` is off, or no links resolve, status falls back to the stored
 * value (completion is still reported when links resolve). Rules, in order:
 *   all linked done → COMPLETED · past due & not all done → MISSED ·
 *   any link in progress → IN_PROGRESS · otherwise → UPCOMING.
 * Dangling links (the work item was deleted) are tolerated and skipped.
 */
export function deriveMilestone(
  milestone: MilestoneWithLinks,
  columnByItemId: Map<string, string>,
  now: Date,
): MilestoneDerivation {
  const columns = milestone.links
    .map((l) => columnByItemId.get(l.workItemId))
    .filter((c): c is string => c !== undefined);

  const linkedTotal = columns.length;
  const linkedDone = columns.filter((c) => c === DONE_COLUMN).length;
  const completionPercent =
    linkedTotal > 0 ? Math.round((linkedDone / linkedTotal) * 100) : null;
  const counts = { linkedTotal, linkedDone, completionPercent };

  if (!milestone.autoStatus || linkedTotal === 0) {
    return { status: milestone.status, completedAt: milestone.completedAt, ...counts };
  }
  if (linkedDone === linkedTotal) {
    return { status: "COMPLETED", completedAt: milestone.completedAt ?? now, ...counts };
  }
  if (milestone.dueDate.getTime() < now.getTime()) {
    return { status: "MISSED", completedAt: null, ...counts };
  }
  const anyInProgress = columns.some(
    (c) => c !== DONE_COLUMN && !NOT_STARTED_COLUMNS.has(c),
  );
  return { status: anyInProgress ? "IN_PROGRESS" : "UPCOMING", completedAt: null, ...counts };
}

const branchSelect = { select: { id: true, code: true, name: true } } as const;

export type DerivedMilestone = Awaited<
  ReturnType<typeof loadMilestonesWithDerived>
>[number];

/**
 * Load a project's milestones with work-item-derived status + completion. One
 * query for milestones (+ links + branch), one for the linked items' columns —
 * no per-milestone fan-out. Derivation is computed on read, never persisted.
 */
export async function loadMilestonesWithDerived(orgId: string, projectId?: string) {
  const milestones = await prisma.milestone.findMany({
    where: projectId ? { orgId, projectId } : { orgId },
    include: { links: true, programBranch: branchSelect },
    orderBy: { dueDate: "asc" },
  });

  const linkedItemIds = Array.from(
    new Set(milestones.flatMap((m) => m.links.map((l) => l.workItemId))),
  );
  const columnByItemId = new Map<string, string>();
  if (linkedItemIds.length > 0) {
    // ids already scope to this org's items; no projectId filter needed (works
    // for both the project tab and the org-wide roll-up).
    const items = await prisma.workItem.findMany({
      where: { id: { in: linkedItemIds }, orgId },
      select: { id: true, columnKey: true },
    });
    for (const item of items) columnByItemId.set(item.id, item.columnKey);
  }

  const now = new Date();
  return milestones.map((m) => ({ ...m, ...deriveMilestone(m, columnByItemId, now) }));
}
