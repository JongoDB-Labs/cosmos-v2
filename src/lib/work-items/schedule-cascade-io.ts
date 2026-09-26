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
import { planScheduleCascade, type CascadeUpdate } from "@/lib/work-items/schedule-cascade";

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
}

/**
 * Apply the cascade for a just-saved item. Returns the items that moved (empty
 * when nothing had to), so the caller can report the count.
 */
export async function cascadeSchedule(db: Db, args: CascadeScheduleArgs): Promise<CascadeUpdate[]> {
  const { orgId, projectId, itemId, dueShiftMs, userId } = args;

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

  const updates = planScheduleCascade(items, links, { id: itemId, dueShiftMs });
  if (updates.length === 0) return [];

  const before = new Map(items.map((i) => [i.id, i]));
  for (const u of updates) {
    await db.workItem.update({
      where: { id: u.id },
      data: { startDate: u.startDate, dueDate: u.dueDate },
    });
  }

  // Same activity shape the PUT route records for a hand-edited date, so the
  // item's history reads identically whether a person or the cascade moved it —
  // "why did this date change" has to be answerable from the item itself.
  const rows: Prisma.ActivityCreateManyInput[] = [];
  for (const u of updates) {
    const prev = before.get(u.id);
    if (!prev) continue;
    for (const field of ["startDate", "dueDate"] as const) {
      const oldVal = prev[field] ? prev[field]!.toISOString() : null;
      const newVal = u[field] ? u[field]!.toISOString() : null;
      if (oldVal === newVal) continue;
      rows.push({
        orgId,
        workItemId: u.id,
        userId,
        action: "updated",
        field,
        oldValue: oldVal,
        newValue: newVal,
      });
    }
  }
  if (rows.length > 0) await db.activity.createMany({ data: rows });

  return updates;
}
