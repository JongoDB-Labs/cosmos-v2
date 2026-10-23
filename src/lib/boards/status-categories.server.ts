import type { ColumnCategory, Prisma, PrismaClient } from "@prisma/client";

export interface StatusCategory {
  key: string;
  category: ColumnCategory;
}

/**
 * Each status key in a project with the category that decides what it means
 * (started, done, cancelled): the server's answer to "is this item done?".
 *
 * Statuses are still board columns, so one key can appear on several boards.
 * The first column by (board order, column order) wins: the same rule the
 * status pickers use for the name, so the label a person sees and the category
 * the server applies come from the same row. It replaces a `findFirst` with no
 * order, which picked an arbitrary board when two disagreed.
 *
 * `keys` narrows the lookup when the caller only needs a few.
 */
export async function loadStatusCategories(
  db: Prisma.TransactionClient | PrismaClient,
  projectId: string,
  keys?: readonly string[],
): Promise<StatusCategory[]> {
  const rows = await db.boardColumn.findMany({
    where: { board: { projectId }, ...(keys ? { key: { in: [...keys] } } : {}) },
    orderBy: [{ board: { sortOrder: "asc" } }, { board: { createdAt: "asc" } }, { sortOrder: "asc" }],
    select: { key: true, category: true },
  });
  const byKey = new Map<string, StatusCategory>();
  for (const row of rows) if (!byKey.has(row.key)) byKey.set(row.key, row);
  return [...byKey.values()];
}
