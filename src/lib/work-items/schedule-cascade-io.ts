/**
 * The persistence half of interdependent rescheduling (FR COSMOS-154).
 *
 * Thin by design: it loads the project's schedule + links, hands them to the
 * pure planner in `schedule-cascade.ts`, and writes back whatever that decides.
 * Every scheduling rule lives in the planner so it can be unit-tested without a
 * database; nothing here decides anything.
 *
 * Runs INSIDE the caller's transaction, so a cascade that fails halfway can't
 * leave the plan half-moved — the item the user saved rolls back with it.
 */
import { Prisma } from "@prisma/client";
import { planScheduleCascade } from "@/lib/work-items/schedule-cascade";

type Db = Prisma.TransactionClient;

export interface CascadeScheduleArgs {
  orgId: string;
  projectId: string;
  /** The item that was just saved. Never rewritten by the cascade. */
  itemId: string;
  /** How far its finish moved LATER, in ms. ≤ 0 means it did not slip. */
  dueShiftMs: number;
  /** Actor, for the activity trail on each item the cascade moved. */
  userId: string;
  /** Other items the SAME user action is writing by hand — see the planner. */
  skipIds?: readonly string[];
}

/** One item the cascade moved, with the dates it moved FROM.
 *
 *  The before-values are the point: a cascade is undone by putting every item it
 *  touched back, and only the request that performed it knows what that set was.
 *  Dropping them would leave the Gantt's Undo able to restore the bar the user
 *  dragged and nothing else. */
export interface CascadedItem {
  id: string;
  reason: "successor-shift" | "parent-envelope";
  before: { startDate: string | null; dueDate: string | null };
  after: { startDate: string | null; dueDate: string | null };
}

const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * Apply the cascade for a just-saved item. Returns the items that moved (empty
 * when nothing had to), each with its before/after dates.
 */
export async function cascadeSchedule(db: Db, args: CascadeScheduleArgs): Promise<CascadedItem[]> {
  const { orgId, projectId, itemId, dueShiftMs, userId, skipIds } = args;

  // Archived items are out of the plan — moving one would resurrect a date
  // nobody is looking at, and it can't be seen on the Gantt to be corrected.
  const items = await db.workItem.findMany({
    where: { orgId, projectId, archivedAt: null },
    select: { id: true, parentId: true, startDate: true, dueDate: true },
  });
  const links = await db.workItemLink.findMany({
    where: { orgId, sourceItem: { projectId }, targetItem: { projectId } },
    select: { type: true, sourceItemId: true, targetItemId: true },
  });

  const updates = planScheduleCascade(items, links, { id: itemId, dueShiftMs, skipIds });
  if (updates.length === 0) return [];

  const before = new Map(items.map((i) => [i.id, i]));
  for (const u of updates) {
    await db.workItem.update({
      where: { id: u.id },
      data: { startDate: u.startDate, dueDate: u.dueDate },
    });
  }
  const moved: CascadedItem[] = updates.map((u) => ({
    id: u.id,
    reason: u.reason,
    before: {
      startDate: isoOrNull(before.get(u.id)?.startDate ?? null),
      dueDate: isoOrNull(before.get(u.id)?.dueDate ?? null),
    },
    after: { startDate: isoOrNull(u.startDate), dueDate: isoOrNull(u.dueDate) },
  }));

  // Same activity shape the PUT route records for a hand-edited date, so the
  // item's history reads identically whether a person or the cascade moved it —
  // "why did this date change" has to be answerable from the item itself.
  const rows: Prisma.ActivityCreateManyInput[] = [];
  for (const m of moved) {
    for (const field of ["startDate", "dueDate"] as const) {
      if (m.before[field] === m.after[field]) continue;
      rows.push({
        orgId,
        workItemId: m.id,
        userId,
        action: "updated",
        field,
        oldValue: m.before[field],
        newValue: m.after[field],
      });
    }
  }
  if (rows.length > 0) await db.activity.createMany({ data: rows });

  return moved;
}
