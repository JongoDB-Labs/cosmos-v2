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

/**
 * Which work item a milestone takes its date from, if any.
 *
 * A milestone marks the delivery of ONE ticket, so its date is that ticket's
 * planned end rather than a second number someone has to keep in step. Applies
 * only when there is EXACTLY ONE link and that item actually has a planned end:
 *
 *   * no links      → the milestone owns its date (7 of 20 on production)
 *   * exactly one   → follow it (13 of 20)
 *   * more than one → the milestone owns its date. Picking one of several
 *     tickets would be a guess, and guessing wrong silently moves a schedule
 *     date, so this declines rather than choosing.
 *   * linked item has no planned end → nothing to follow; keep the milestone's.
 */
export function milestoneDateSource(
  links: readonly { workItemId: string }[],
  dueDateByItemId: ReadonlyMap<string, Date | null>,
): { workItemId: string; dueDate: Date } | null {
  if (links.length !== 1) return null;
  const workItemId = links[0].workItemId;
  const dueDate = dueDateByItemId.get(workItemId) ?? null;
  return dueDate ? { workItemId, dueDate } : null;
}

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
  const dueDateByItemId = new Map<string, Date | null>();
  if (linkedItemIds.length > 0) {
    // ids already scope to this org's items; no projectId filter needed (works
    // for both the project tab and the org-wide roll-up).
    const items = await prisma.workItem.findMany({
      where: { id: { in: linkedItemIds }, orgId },
      select: { id: true, columnKey: true, dueDate: true },
    });
    for (const item of items) {
      columnByItemId.set(item.id, item.columnKey);
      dueDateByItemId.set(item.id, item.dueDate);
    }
  }

  const now = new Date();
  return milestones.map((m) => {
    const follows = milestoneDateSource(m.links, dueDateByItemId);
    return {
      ...m,
      // The DATE follows the ticket, derived on read like the status above and
      // never persisted — so the milestone cannot drift from the delivery it
      // marks. Two milestones on production already had: 2026-08-10 and
      // 2026-08-23 against tickets planned for 2026-09-25.
      ...(follows ? { dueDate: follows.dueDate } : {}),
      /** The work item this milestone's date follows, or null when it owns it. */
      dateFollowsWorkItemId: follows?.workItemId ?? null,
      ...deriveMilestone(m, columnByItemId, now),
    };
  });
}
