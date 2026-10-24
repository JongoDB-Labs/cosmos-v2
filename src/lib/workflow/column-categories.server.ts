/**
 * A board column's category, read from its status.
 *
 * Statuses own their category (P1); a column used to keep its own copy, written
 * in step by every path that changed one. From P3.1 the copy is no longer
 * written: whatever returns or reads a column takes its category from here.
 *
 * One exception keeps the boards the P1 backfill found disagreeing as they
 * were: where a status's boards had different categories for it (an audit
 * `workflow.backfill_conflict` row), a column whose own category differs keeps
 * it until an admin resolves the conflict in Settings → Workflows (keep the
 * status's category, or take this board's). So nothing changes what "done"
 * means on any board until someone decides it should.
 */
import type { BoardType, ColumnCategory, Prisma, PrismaClient } from "@prisma/client";
import { BOARD_TYPE_REGISTRY } from "@/lib/boards/board-types";
import { boardShowsStatuses, setStatusCategory } from "@/lib/workflow/statuses.server";

type Db = Prisma.TransactionClient | PrismaClient;

export const CONFLICT = "workflow.backfill_conflict";
export const CONFLICT_RESOLVED = "workflow.backfill_conflict_resolved";

/**
 * The project's statuses whose backfill conflict nobody has resolved yet: for
 * each, the category the backfill chose for the status. A lane is one of the
 * disagreeing ones when its own category isn't that: lanes that agreed then
 * follow the status like any other, through any change to it since.
 */
async function openConflicts(db: Db, statuses: readonly { id: string; category: ColumnCategory }[]): Promise<Map<string, ColumnCategory>> {
  if (statuses.length === 0) return new Map();
  const rows = await db.auditLog.findMany({
    where: { action: { in: [CONFLICT, CONFLICT_RESOLVED] }, entity: "workflow_status", entityId: { in: statuses.map((s) => s.id) } },
    select: { action: true, entityId: true, metadata: true },
  });
  const resolved = new Set(rows.filter((r) => r.action === CONFLICT_RESOLVED).map((r) => r.entityId));
  const current = new Map(statuses.map((s) => [s.id, s.category]));
  const open = new Map<string, ColumnCategory>();
  for (const r of rows) {
    if (r.action !== CONFLICT || !r.entityId || resolved.has(r.entityId)) continue;
    const chosen = (r.metadata as { chosenCategory?: ColumnCategory } | null)?.chosenCategory;
    open.set(r.entityId, chosen ?? current.get(r.entityId)!);
  }
  return open;
}

/** A function from a column (key and its stored category) to the category it has. */
export async function columnCategoryResolver(db: Db, projectId: string) {
  const statuses = await db.workflowStatus.findMany({ where: { projectId }, select: { id: true, key: true, category: true } });
  const conflicted = await openConflicts(db, statuses);
  const byKey = new Map(statuses.map((s) => [s.key, s]));
  return (col: { key: string; category: ColumnCategory }): ColumnCategory => {
    const status = byKey.get(col.key);
    if (!status) return col.category;
    const chosen = conflicted.get(status.id);
    if (chosen && col.category !== chosen) return col.category;
    return status.category;
  };
}

/** Boards with each status column's category taken from its status (ceremony boards keep their prompts' own). */
export async function withStatusCategories<
  B extends { type: BoardType; columns: { key: string; category: ColumnCategory }[] },
>(db: Db, projectId: string, boards: B[]): Promise<B[]> {
  // A board with no columns (or a partial row) has nothing to take a category.
  const shows = (b: B) => (b.columns?.length ?? 0) > 0 && b.type in BOARD_TYPE_REGISTRY && boardShowsStatuses(b.type);
  if (!boards.some(shows)) return boards;
  const categoryOf = await columnCategoryResolver(db, projectId);
  return boards.map((b) => (shows(b) ? { ...b, columns: b.columns.map((c) => ({ ...c, category: categoryOf(c) })) } : b));
}

export interface BackfillConflict {
  statusId: string;
  key: string;
  statusCategory: ColumnCategory;
  /** The boards whose column disagrees with the status, with the category each has. */
  boards: { boardId: string; boardName: string; category: ColumnCategory }[];
}

/** A project's unresolved backfill conflicts, for the workflow editor's Statuses tab. */
export async function listBackfillConflicts(db: Db, projectId: string): Promise<BackfillConflict[]> {
  const statuses = await db.workflowStatus.findMany({ where: { projectId }, select: { id: true, key: true, category: true } });
  const open = await openConflicts(db, statuses);
  const out: BackfillConflict[] = [];
  for (const s of statuses) {
    const chosen = open.get(s.id);
    if (!chosen) continue;
    const columns = await db.boardColumn.findMany({
      where: { key: s.key, category: { not: chosen }, board: { projectId } },
      select: { category: true, board: { select: { id: true, name: true, type: true } } },
    });
    const boards = columns
      .filter((c) => boardShowsStatuses(c.board.type))
      .map((c) => ({ boardId: c.board.id, boardName: c.board.name, category: c.category }));
    // A conflict whose lanes all agree by now (columns renamed or removed) is no conflict.
    if (boards.length > 0) out.push({ statusId: s.id, key: s.key, statusCategory: s.category, boards });
  }
  return out;
}

/**
 * Resolve a backfill conflict: keep the status's category, or take the
 * category a board's column has. Either way the conflict is closed (an audit
 * row), and from then on every column showing the status reads its category.
 */
export async function resolveBackfillConflict(
  tx: Prisma.TransactionClient,
  args: { orgId: string; projectId: string; key: string; take: "status" | ColumnCategory; actorId: string },
): Promise<ColumnCategory> {
  const status = await tx.workflowStatus.findUniqueOrThrow({
    where: { projectId_key: { projectId: args.projectId, key: args.key } },
    select: { id: true, category: true },
  });
  const category = args.take === "status" ? status.category : args.take;
  await setStatusCategory(tx, args.projectId, args.key, category);
  await tx.auditLog.create({
    data: {
      orgId: args.orgId,
      userId: args.actorId,
      action: CONFLICT_RESOLVED,
      entity: "workflow_status",
      entityId: status.id,
      metadata: { projectId: args.projectId, key: args.key, category, from: status.category },
    },
  });
  return category;
}
