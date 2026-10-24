import type { ColumnCategory, Prisma, PrismaClient } from "@prisma/client";

export interface StatusCategory {
  key: string;
  category: ColumnCategory;
}

/**
 * Each status key in a project with the category that decides what it means
 * (started, done, cancelled): the server's answer to "is this item done?".
 *
 * Read from `workflow_statuses`, the one row per status. Archived statuses are
 * included: an item can still sit in one, and its category still says what
 * that means. `keys` narrows the lookup when the caller only needs a few.
 */
export async function loadStatusCategories(
  db: Prisma.TransactionClient | PrismaClient,
  projectId: string,
  keys?: readonly string[],
): Promise<StatusCategory[]> {
  return db.workflowStatus.findMany({
    where: { projectId, ...(keys ? { key: { in: [...keys] } } : {}) },
    orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    select: { key: true, category: true },
  });
}
