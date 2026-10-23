/**
 * The only module that writes `work_items` rows.
 *
 * Every create and update of a work item, from any route, executor, import or
 * background job, goes through one of the functions below, and
 * `single-writer.arch.test.ts` fails the build on a `workItem.create/update…`
 * (or raw `UPDATE work_items`) anywhere else in `src/`. Seven write paths used to
 * each carry their own copy of what a status change does, and they disagreed:
 * bulk moves stamped no dates, the assistant decided "done" from the column's
 * spelling. One door is what lets a rule be enforced once.
 *
 * Status is special. A status change has consequences (dates, cancel fields,
 * history), and those live in `applyWorkItemChange`. So `updateWorkItems`
 * refuses the status fields outright; only the change service, and an import
 * restoring another system's recorded state, may write them, through
 * `updateWorkItemsUnchecked`, which the architecture test restricts to those
 * two callers.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

/** The root client or an interactive-transaction client. */
export type WorkItemDb = Prisma.TransactionClient | PrismaClient;

/**
 * Fields that only a status change may write: the status itself and everything
 * derived from moving between statuses.
 */
export const STATUS_FIELDS = [
  "columnKey",
  "columnEnteredAt",
  "actualStart",
  "completedAt",
  "cancelReason",
  "cancelNote",
  "mergedIntoId",
] as const;

export class StatusFieldWriteError extends Error {
  constructor(fields: string[]) {
    super(`Status fields (${fields.join(", ")}) change only through applyWorkItemChange.`);
    this.name = "StatusFieldWriteError";
  }
}

/** Create one work item row. */
export function createWorkItemRow<T extends Prisma.WorkItemCreateArgs>(
  db: WorkItemDb,
  args: Prisma.SelectSubset<T, Prisma.WorkItemCreateArgs>,
) {
  return db.workItem.create<T>(args);
}

/**
 * Write non-status fields on the given items: the same data on each. Returns
 * how many rows matched.
 *
 * Throws `StatusFieldWriteError` if `data` names a status field: a status
 * change goes through `applyWorkItemChange`, which owns its consequences.
 */
export async function updateWorkItems(
  db: WorkItemDb,
  ids: readonly string[],
  data: Prisma.WorkItemUncheckedUpdateManyInput,
): Promise<number> {
  const statusFields = STATUS_FIELDS.filter((f) => f in data);
  if (statusFields.length > 0) throw new StatusFieldWriteError(statusFields);
  return updateWorkItemsUnchecked(db, ids, data);
}

/**
 * `updateWorkItems` without the status-field check. Callers are limited by the
 * architecture test to the change service and the import engine.
 */
export async function updateWorkItemsUnchecked(
  db: WorkItemDb,
  ids: readonly string[],
  data: Prisma.WorkItemUncheckedUpdateManyInput,
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await db.workItem.updateMany({ where: { id: { in: [...ids] } }, data });
  return result.count;
}

/**
 * Rebuild the `tags` mirror for the given items from their join rows. See
 * `recomputeTagMirror` in `labels.ts`, which owns when this runs.
 */
export async function rebuildTagMirror(db: WorkItemDb, workItemIds: readonly string[]): Promise<void> {
  if (workItemIds.length === 0) return;
  // The COALESCE is for the column's sake, not the caller's: array_agg over
  // zero rows yields NULL, and `tags` is nullable, so an item losing its last
  // label would be stored as NULL among rows that all hold '{}'. Prisma reads
  // either back as [], so this is invisible from the app — it matters to the
  // raw-SQL readers, where `= ANY(NULL)` is NULL rather than false.
  await db.$executeRaw`
    UPDATE work_items w
    SET tags = COALESCE((
      SELECT array_agg(l.name ORDER BY l.name)
      FROM work_item_labels wl
      JOIN labels l ON l.id = wl.label_id
      WHERE wl.work_item_id = w.id
    ), ARRAY[]::text[])
    WHERE w.id = ANY(${[...workItemIds]}::uuid[])
  `;
}
