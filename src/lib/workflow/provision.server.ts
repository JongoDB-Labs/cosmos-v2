/**
 * Setting a new project's (or board's) columns up, statuses first.
 *
 * Every column on a delivery board is a view onto one of the project's
 * statuses, and a work item can only be in a status that exists. So the status
 * rows are created before the columns that show them, the columns take their
 * category from the status (the first board to name a key decides it), and the
 * project creation route, its templates and the assistant all go through here
 * rather than each writing columns its own way.
 */
import type { BoardType, ColumnCategory, Prisma } from "@prisma/client";
import { boardShowsStatuses, ensureStatuses } from "@/lib/workflow/statuses.server";

export interface ColumnSpec {
  name: string;
  key: string;
  color?: string | null;
  sortOrder?: number;
  category?: ColumnCategory;
}

export async function seedBoardColumns(
  tx: Prisma.TransactionClient,
  board: { orgId: string; projectId: string; id: string; type: BoardType },
  columns: readonly ColumnSpec[],
): Promise<void> {
  if (columns.length === 0) return;
  const showsStatuses = boardShowsStatuses(board.type);
  const categories = new Map<string, ColumnCategory>();
  if (showsStatuses) {
    await ensureStatuses(
      tx,
      { orgId: board.orgId, projectId: board.projectId },
      // Every column here is new, so it restores an archived status it names.
      // Its category is passed as given: a default must not overwrite an
      // existing status's category.
      columns.map((c, i) => ({ key: c.key, name: c.name, color: c.color, category: c.category, sortOrder: c.sortOrder ?? i, restore: true })),
    );
    const rows = await tx.workflowStatus.findMany({
      where: { projectId: board.projectId, key: { in: columns.map((c) => c.key) } },
      select: { key: true, category: true },
    });
    for (const r of rows) categories.set(r.key, r.category);
  }
  await tx.boardColumn.createMany({
    data: columns.map((c, i) => ({
      boardId: board.id,
      name: c.name,
      key: c.key,
      color: c.color ?? "#7dd3fc",
      sortOrder: c.sortOrder ?? i,
      category: categories.get(c.key) ?? c.category ?? "TODO",
    })),
  });
}
