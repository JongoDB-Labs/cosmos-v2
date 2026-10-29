/**
 * A project's statuses: the `workflow_statuses` rows every work item's
 * `column_key` must name.
 *
 * Statuses used to be board columns, one copy per board, and nothing tied an
 * item to one: deleting a column orphaned its items, renaming one left them on
 * a key nobody showed, and two boards could disagree on what a key meant. Now a
 * status is one project-level row, board columns are views onto statuses, and
 * every code path that creates columns goes through here so the status exists
 * first.
 */
import type { BoardType, ColumnCategory, Prisma, PrismaClient } from "@prisma/client";
import { BOARD_TYPE_REGISTRY } from "@/lib/boards/board-types";
import { CANCELLED_COLUMN } from "@/lib/boards/default-columns";

type Db = Prisma.TransactionClient | PrismaClient;

export interface StatusSpec {
  key: string;
  name: string;
  color?: string | null;
  /** Required to create; for an existing status, see `ensureStatuses`. */
  category?: ColumnCategory;
  sortOrder?: number;
  /**
   * Restore the status if it is archived. Only something that starts using the
   * status in this request sets this — a new column, one re-keyed to it, or a
   * cancel reaching for the project's Cancelled status: a column that already
   * showed it is not a decision to use it again.
   */
  restore?: boolean;
}

export interface StatusRow {
  id: string;
  key: string;
  name: string;
  color: string;
  category: ColumnCategory;
  sortOrder: number;
  archivedAt: Date | null;
}

const STATUS_SELECT = {
  id: true,
  key: true,
  name: true,
  color: true,
  category: true,
  sortOrder: true,
  archivedAt: true,
} as const;

/** The project's statuses in workflow order; archived ones only when asked for. */
export function loadStatuses(
  db: Db,
  projectId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<StatusRow[]> {
  return db.workflowStatus.findMany({
    where: { projectId, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    select: STATUS_SELECT,
  });
}

/** Board types whose columns are statuses (not a ceremony's prompts). */
export function boardShowsStatuses(type: BoardType): boolean {
  return BOARD_TYPE_REGISTRY[type].columnsAreStatuses;
}

/** The same, as a list for a `board: { type: { in } }` filter. */
export const STATUS_BOARD_TYPES = (Object.keys(BOARD_TYPE_REGISTRY) as BoardType[]).filter(boardShowsStatuses);

/** How many of the project's items are in each status, by key. */
export async function statusCounts(db: Db, projectId: string): Promise<Map<string, number>> {
  const rows = await db.workItem.groupBy({ by: ["columnKey"], where: { projectId }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.columnKey, r._count._all]));
}

/** A status as the API returns it. */
export function toStatusDto(row: StatusRow, items?: number) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    color: row.color,
    category: row.category,
    sortOrder: row.sortOrder,
    archived: row.archivedAt !== null,
    ...(items !== undefined && { items }),
  };
}

/**
 * Make sure each spec's status exists. A missing one is created (as TODO when
 * the spec gives no category); an existing one keeps its name, colour and
 * order (statuses are shared, and one board's spelling must not rename them
 * for every board).
 *
 * An existing status changes in two cases only, so that saving a board's
 * columns, which sends every column, never undoes a decision made elsewhere:
 *
 * - A spec with `restore` restores the status if it is archived, and the
 *   spec's category, where it gives one, becomes the status's (the archived
 *   row's category was a guess from its key, in the backfill, or belongs to
 *   the status's earlier life).
 * - With `writeCategory`, a spec's category, where it gives one, is written
 *   to the status: the board column editor still edits a column's category,
 *   and the status is now where that lives. The caller passes a category only
 *   when the request changes it; a spec without one never resets a status to
 *   the TODO default.
 *
 * A category written to a status is written to every column showing it.
 */
export async function ensureStatuses(
  tx: Prisma.TransactionClient,
  scope: { orgId: string; projectId: string },
  specs: readonly StatusSpec[],
  opts: { writeCategory?: boolean } = {},
): Promise<void> {
  if (specs.length === 0) return;
  const existing = await tx.workflowStatus.findMany({
    where: { projectId: scope.projectId, key: { in: specs.map((s) => s.key) } },
    select: { key: true, category: true, sortOrder: true, archivedAt: true },
  });
  const have = new Map(existing.map((s) => [s.key, s]));
  const nextOrder =
    ((await tx.workflowStatus.aggregate({ where: { projectId: scope.projectId }, _max: { sortOrder: true } }))._max
      .sortOrder ?? -1) + 1;

  const missing = specs.filter((s) => !have.has(s.key));
  if (missing.length > 0) {
    await tx.workflowStatus.createMany({
      data: missing.map((s, i) => ({
        orgId: scope.orgId,
        projectId: scope.projectId,
        key: s.key,
        name: s.name,
        ...(s.color ? { color: s.color } : {}),
        category: s.category ?? "TODO",
        sortOrder: s.sortOrder ?? nextOrder + i,
      })),
      // A concurrent request may have created the same key first.
      skipDuplicates: true,
    });
  }

  for (const spec of specs) {
    const row = have.get(spec.key);
    if (!row) continue;
    const restoring = Boolean(spec.restore) && row.archivedAt !== null;
    const recategorise =
      spec.category !== undefined && row.category !== spec.category && (restoring || Boolean(opts.writeCategory));
    if (restoring) {
      await tx.workflowStatus.update({
        where: { projectId_key: { projectId: scope.projectId, key: spec.key } },
        data: { archivedAt: null },
      });
    }
    if (recategorise) await setStatusCategory(tx, scope.projectId, spec.key, spec.category!);
  }
}

/**
 * A status's category. Columns showing it read it from here
 * (column-categories.server.ts); their own stored category is no longer kept
 * in step, and only still counts on a lane the backfill found conflicting.
 */
export async function setStatusCategory(
  tx: Prisma.TransactionClient,
  projectId: string,
  key: string,
  category: ColumnCategory,
): Promise<void> {
  await tx.workflowStatus.update({ where: { projectId_key: { projectId, key } }, data: { category } });
}

/**
 * A column's key changed from `from` to `to`. When no other board still shows
 * `from` and `to` is not already a status, this is a rename of the status: its
 * key changes and every item in it follows (ON UPDATE CASCADE), instead of being
 * left on a key nothing shows. Otherwise the column simply shows a different
 * status, created if needed by the caller's `ensureStatuses`.
 */
export async function renameStatusIfUnshared(
  tx: Prisma.TransactionClient,
  args: { projectId: string; from: string; to: string; columnId: string },
): Promise<boolean> {
  const { projectId, from, to, columnId } = args;
  if (from === to) return false;
  const [otherColumns, target] = await Promise.all([
    tx.boardColumn.count({
      where: { key: from, id: { not: columnId }, board: { projectId, type: { in: STATUS_BOARD_TYPES } } },
    }),
    tx.workflowStatus.findUnique({ where: { projectId_key: { projectId, key: to } }, select: { id: true } }),
  ]);
  if (otherColumns > 0 || target) return false;
  const renamed = await tx.workflowStatus.updateMany({ where: { projectId, key: from }, data: { key: to } });
  return renamed.count > 0;
}

/**
 * The key of the project's Cancelled status, adding one if it has none.
 *
 * Boards made before COSMOS-206 have no Cancelled column, so the status is
 * created the first time something in the project is cancelled, and a column
 * showing it is appended to each board whose columns are statuses (ceremony
 * boards keep their prompts, and boards with no columns are left alone).
 * `preferredKey` wins when it names one of the project's Cancelled statuses.
 *
 * A project whose Cancelled status is ARCHIVED still has one: archiving hides a
 * status from the pickers, and the items in it keep it. So cancelling restores
 * that status (`restore`, as a column re-keyed to it does) rather than adding a
 * second "Cancelled" beside it and appending another Cancelled lane to every
 * board — which is precisely the lane the archiving had cleared away. A key
 * taken by a status that means something ELSE still yields a fresh one.
 *
 * Anyone who may edit an item can cause this, without board-manage rights: the
 * status is the representation of "cancelled", not a design choice about the
 * board. Two first cancels racing in a project pick the same key, and the
 * second insert is skipped rather than failing.
 */
export async function ensureCancelledStatus(
  tx: Prisma.TransactionClient,
  projectId: string,
  preferredKey?: string | null,
): Promise<string> {
  const cancelled = await tx.workflowStatus.findMany({
    where: { projectId, category: "CANCELLED" },
    orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    select: { key: true, archivedAt: true },
  });
  const inUse = cancelled.filter((s) => s.archivedAt === null);
  if (preferredKey && inUse.some((s) => s.key === preferredKey)) return preferredKey;
  if (inUse.length > 0) return inUse[0].key;

  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { orgId: true } });
  // An archived Cancelled status of its own comes back; only a project with
  // none at all gets a new one, on the first key nothing else has taken.
  let key = preferredKey && cancelled.some((s) => s.key === preferredKey) ? preferredKey : cancelled[0]?.key;
  if (!key) {
    const taken = new Set(
      (await tx.workflowStatus.findMany({ where: { projectId }, select: { key: true } })).map((s) => s.key),
    );
    key = CANCELLED_COLUMN.key;
    for (let i = 2; taken.has(key); i++) key = `${CANCELLED_COLUMN.key}-${i}`;
  }

  await ensureStatuses(tx, { orgId: project.orgId, projectId }, [
    { key, name: CANCELLED_COLUMN.name, color: CANCELLED_COLUMN.color, category: CANCELLED_COLUMN.category, restore: true },
  ]);

  const boards = await tx.board.findMany({
    where: { projectId, columns: { some: {} } },
    select: { id: true, type: true, columns: { select: { sortOrder: true } } },
  });
  const statusBoards = boards.filter((b) => boardShowsStatuses(b.type));
  if (statusBoards.length > 0) {
    await tx.boardColumn.createMany({
      data: statusBoards.map((b) => ({
        boardId: b.id,
        key,
        name: CANCELLED_COLUMN.name,
        color: CANCELLED_COLUMN.color,
        category: CANCELLED_COLUMN.category,
        sortOrder: Math.max(-1, ...b.columns.map((c) => c.sortOrder)) + 1,
      })),
      // A concurrent first cancel may have just added the same (boardId, key).
      skipDuplicates: true,
    });
  }
  return key;
}
