import type { ColumnCategory, Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/** The default board's statuses (src/lib/boards/default-columns.ts), for seeds
 *  that put items in a project before, or without, giving it a board. */
export const DEFAULT_SEED_STATUSES: { key: string; name: string; category: ColumnCategory }[] = [
  { key: "backlog", name: "Backlog", category: "TODO" },
  { key: "todo", name: "To Do", category: "TODO" },
  { key: "in-progress", name: "In Progress", category: "IN_PROGRESS" },
  { key: "review", name: "Review", category: "IN_PROGRESS" },
  { key: "done", name: "Done", category: "DONE" },
];

/**
 * Give a seeded project the statuses its items need.
 *
 * A work item's `column_key` must name one of its project's `workflow_statuses`
 * (a foreign key), so a seed creates statuses before items. This mirrors the
 * 20261023230000_workflow_statuses backfill for one project: a status for every
 * key its delivery boards show, named and categorised by the first column (ceremony
 * boards skipped). `extra` adds keys a seed uses without a column showing them.
 * Idempotent.
 */
export async function ensureSeedStatuses(
  db: Db,
  projectId: string,
  extra: { key: string; name: string; category: ColumnCategory }[] = [],
): Promise<void> {
  await db.$executeRaw`
    WITH status_columns AS (
      SELECT b.org_id, b.project_id, bc.key, bc.name, bc.color, bc.category,
             b.sort_order AS board_order, b.created_at AS board_created, bc.sort_order AS column_order,
             row_number() OVER (
               PARTITION BY b.project_id, bc.key ORDER BY b.sort_order, b.created_at, bc.sort_order, bc.id
             ) AS rn
      FROM board_columns bc
      JOIN boards b ON b.id = bc.board_id
      WHERE b.project_id = ${projectId}::uuid AND b.type NOT IN ('SPRINT_PLANNING', 'SPRINT_REVIEW')
    )
    INSERT INTO workflow_statuses (org_id, project_id, key, name, color, category, sort_order)
    SELECT org_id, project_id, key, name, color, category,
           (row_number() OVER (ORDER BY board_order, board_created, column_order, key) - 1)::int
    FROM status_columns WHERE rn = 1
    ON CONFLICT (project_id, key) DO NOTHING
  `;
  if (extra.length === 0) return;
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { orgId: true } });
  await db.workflowStatus.createMany({
    data: extra.map((s, i) => ({ orgId: project.orgId, projectId, key: s.key, name: s.name, category: s.category, sortOrder: 100 + i })),
    skipDuplicates: true,
  });
}
