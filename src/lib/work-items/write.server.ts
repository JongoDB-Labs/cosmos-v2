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
 *
 * Every primitive also records the change in the domain-event outbox
 * (`events.server.ts`), in the same transaction as the write, so automations
 * and webhooks see every committed change and none that rolled back. Each one
 * takes a `WriteMeta` (who, through what) for that; the change service passes
 * `RECORDED_BY_CALLER` instead and records richer events itself. `meta` is
 * optional for the composed plugins' sake only (see PLUGIN_WRITE).
 */
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  PLUGIN_WRITE,
  RECORDED_BY_CALLER,
  eventValue,
  inTransaction,
  recordEvents,
  type DomainEventInput,
  type WriteMeta,
  type WriteMetaOrCaller,
} from "@/lib/work-items/events.server";

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

// The type a plain `workItem.create(args)` returns: a PrismaPromise, which a
// caller can put in an array `$transaction([...])`.
declare const workItemDelegate: PrismaClient["workItem"];
type PlainCreate<T extends Prisma.WorkItemCreateArgs> = ReturnType<typeof workItemDelegate.create<T>>;

/**
 * Create one work item row, and its `work_item.created` event.
 *
 * Without `meta` (a composed plugin's call, written before the outbox) this is
 * exactly the plain create it always was, PrismaPromise and all, so a plugin
 * that batches it in an array `$transaction([...])` keeps working; such a write
 * records no event until it passes meta. Every call in this repository passes
 * it (write-meta.arch.test.ts).
 */
export function createWorkItemRow<T extends Prisma.WorkItemCreateArgs>(
  db: WorkItemDb,
  args: Prisma.SelectSubset<T, Prisma.WorkItemCreateArgs>,
): PlainCreate<T>;
export function createWorkItemRow<T extends Prisma.WorkItemCreateArgs>(
  db: WorkItemDb,
  args: Prisma.SelectSubset<T, Prisma.WorkItemCreateArgs>,
  meta: WriteMeta | undefined,
): Promise<Awaited<PlainCreate<T>>>;
export function createWorkItemRow<T extends Prisma.WorkItemCreateArgs>(
  db: WorkItemDb,
  args: Prisma.SelectSubset<T, Prisma.WorkItemCreateArgs>,
  meta?: WriteMeta,
): PlainCreate<T> | Promise<Awaited<PlainCreate<T>>> {
  if (meta === undefined) return db.workItem.create<T>(args);
  // The id is chosen here so the event can name the row whatever `select` the
  // caller asked for; the rest of the event is read back from the row, so a
  // `project: { connect }` form works like a plain projectId.
  const data = args.data as { id?: string };
  const id = data.id ?? randomUUID();
  const write = inTransaction(db, async (tx) => {
    const row = await tx.workItem.create<T>({ ...args, data: { ...args.data, id } } as Prisma.SelectSubset<T, Prisma.WorkItemCreateArgs>);
    const created = await tx.workItem.findUniqueOrThrow({
      where: { id },
      select: { orgId: true, projectId: true, ticketNumber: true, columnKey: true, workItemTypeId: true, parentId: true },
    });
    await recordEvents(tx, meta, [
      {
        orgId: created.orgId,
        projectId: created.projectId,
        type: "work_item.created",
        subjectId: id,
        payload: {
          ticketNumber: created.ticketNumber,
          columnKey: created.columnKey,
          workItemTypeId: created.workItemTypeId,
          parentId: created.parentId,
        },
      },
    ]);
    return row;
  });
  return write as unknown as Promise<Awaited<PlainCreate<T>>>;
}

type ItemSnapshot = { id: string; orgId: string; projectId: string } & Record<string, unknown>;

/**
 * The events for rows read before and after a write: one per item where a
 * field changed, `work_item.transitioned` when its status did. A payload holds
 * each changed field's before and after (free text only named, see eventValue).
 */
export function changeEvents(
  before: readonly ItemSnapshot[],
  after: readonly ItemSnapshot[],
  fields: readonly string[],
): DomainEventInput[] {
  const afterById = new Map(after.map((r) => [r.id, r]));
  return before.flatMap((b): DomainEventInput[] => {
    const a = afterById.get(b.id);
    if (!a) return [];
    const changes: Record<string, { from: Prisma.InputJsonValue | null; to: Prisma.InputJsonValue | null }> = {};
    for (const f of fields) {
      if (JSON.stringify(b[f] ?? null) === JSON.stringify(a[f] ?? null)) continue;
      changes[f] = { from: eventValue(f, b[f]), to: eventValue(f, a[f]) };
    }
    if (Object.keys(changes).length === 0) return [];
    const moved = "columnKey" in changes;
    return [
      {
        orgId: b.orgId,
        projectId: b.projectId,
        type: moved ? "work_item.transitioned" : "work_item.updated",
        subjectId: b.id,
        payload: moved
          ? { from: b.columnKey as string, to: a.columnKey as string, changes }
          : { changes },
      },
    ];
  });
}

/** Read the given fields of the given items, with what an event needs to name them. */
export function snapshotItems(
  tx: Prisma.TransactionClient,
  ids: readonly string[],
  fields: readonly string[],
): Promise<ItemSnapshot[]> {
  const select: Record<string, true> = { id: true, orgId: true, projectId: true };
  for (const f of fields) select[f] = true;
  return tx.workItem.findMany({ where: { id: { in: [...ids] } }, select }) as unknown as Promise<ItemSnapshot[]>;
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
  meta: WriteMetaOrCaller = PLUGIN_WRITE,
): Promise<number> {
  const statusFields = STATUS_FIELDS.filter((f) => f in data);
  if (statusFields.length > 0) throw new StatusFieldWriteError(statusFields);
  return updateWorkItemsUnchecked(db, ids, data, meta);
}

/**
 * `updateWorkItems` without the status-field check. Callers are limited by the
 * architecture test to the change service and the import engine.
 */
export async function updateWorkItemsUnchecked(
  db: WorkItemDb,
  ids: readonly string[],
  data: Prisma.WorkItemUncheckedUpdateManyInput,
  meta: WriteMetaOrCaller = PLUGIN_WRITE,
): Promise<number> {
  if (ids.length === 0) return 0;
  const write = async (tx: WorkItemDb) =>
    (await tx.workItem.updateMany({ where: { id: { in: [...ids] } }, data })).count;
  if (meta === RECORDED_BY_CALLER) return write(db);
  const fields = Object.keys(data).filter((k) => data[k as keyof typeof data] !== undefined);
  return inTransaction(db, async (tx) => {
    const before = await snapshotItems(tx, ids, fields);
    const count = await write(tx);
    await recordEvents(tx, meta, changeEvents(before, await snapshotItems(tx, ids, fields), fields));
    return count;
  });
}

/**
 * Rebuild the `tags` mirror for the given items from their join rows. See
 * `recomputeTagMirror` in `labels.ts`, which owns when this runs.
 */
export async function rebuildTagMirror(
  db: WorkItemDb,
  workItemIds: readonly string[],
  meta: WriteMetaOrCaller = PLUGIN_WRITE,
): Promise<void> {
  if (workItemIds.length === 0) return;
  // The COALESCE is for the column's sake, not the caller's: array_agg over
  // zero rows yields NULL, and `tags` is nullable, so an item losing its last
  // label would be stored as NULL among rows that all hold '{}'. Prisma reads
  // either back as [], so this is invisible from the app — it matters to the
  // raw-SQL readers, where `= ANY(NULL)` is NULL rather than false.
  const write = (tx: WorkItemDb) => tx.$executeRaw`
    UPDATE work_items w
    SET tags = COALESCE((
      SELECT array_agg(l.name ORDER BY l.name)
      FROM work_item_labels wl
      JOIN labels l ON l.id = wl.label_id
      WHERE wl.work_item_id = w.id
    ), ARRAY[]::text[])
    WHERE w.id = ANY(${[...workItemIds]}::uuid[])
  `;
  if (meta === RECORDED_BY_CALLER) {
    await write(db);
    return;
  }
  await inTransaction(db, async (tx) => {
    const before = await snapshotItems(tx, workItemIds, ["tags"]);
    await write(tx);
    await recordEvents(tx, meta, changeEvents(before, await snapshotItems(tx, workItemIds, ["tags"]), ["tags"]));
  });
}
