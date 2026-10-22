import type { Prisma } from "@prisma/client";
import { CANCELLED_COLUMN } from "@/lib/boards/default-columns";

/**
 * The key of the project's Cancelled status, adding one if it has none.
 *
 * Statuses are board columns, and boards made before COSMOS-206 have no
 * CANCELLED column (new projects get one from DEFAULT_COLUMNS). Rather than add one to every board in every project, it is
 * added the first time something in the project is cancelled, at the end of
 * each board that has a workflow (boards with no columns are left alone). Its
 * key never collides with an existing column's. `preferredKey` wins when it
 * already names one of the project's CANCELLED columns.
 *
 * This adds a status as a side effect of cancelling, so anyone who may edit an
 * item can cause it, without board-manage rights. That is the intended lazy
 * creation: the column is the representation of "cancelled", not a design
 * choice about the board. Two first cancels racing in the same project pick the
 * same key, so the second insert is skipped rather than failing.
 */
export async function ensureCancelledColumn(
  tx: Prisma.TransactionClient,
  projectId: string,
  preferredKey?: string | null,
): Promise<string> {
  const existing = await tx.boardColumn.findMany({
    where: { board: { projectId }, category: "CANCELLED" },
    orderBy: { sortOrder: "asc" },
    select: { key: true },
  });
  if (preferredKey && existing.some((c) => c.key === preferredKey)) return preferredKey;
  if (existing.length > 0) return existing[0].key;

  const boards = await tx.board.findMany({
    where: { projectId, columns: { some: {} } },
    select: { id: true, columns: { select: { key: true, sortOrder: true } } },
  });
  const taken = new Set(boards.flatMap((b) => b.columns.map((c) => c.key)));
  let key = CANCELLED_COLUMN.key;
  for (let i = 2; taken.has(key); i++) key = `${CANCELLED_COLUMN.key}-${i}`;

  if (boards.length > 0) {
    await tx.boardColumn.createMany({
      data: boards.map((b) => ({
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
