import { prisma } from "@/lib/db/client";
import type { ColumnCategory } from "@prisma/client";
import { createWorkItemRow } from "@/lib/work-items/write.server";
import { allocateTicketNumber } from "@/lib/work-items/allocate";
import { DEFAULT_COLUMNS } from "@/lib/boards/default-columns";
import { ensureStatuses } from "@/lib/workflow/statuses.server";

/**
 * Fixture helpers for the DB-backed specs.
 *
 * Imported only from `*.test.ts`, so nothing here reaches a build — but it is
 * ordinary source, and `tsc` checks it like anything else.
 *
 * ## Why this exists
 *
 * Two specs created a work item by reading the project's highest ticket number
 * and inserting `max + 1`:
 *
 * ```ts
 * const last = await prisma.workItem.findFirst({
 *   where: { projectId }, orderBy: { ticketNumber: "desc" },
 * });
 * await createWorkItemRow(prisma, { data: { ticketNumber: (last?.ticketNumber ?? 0) + 1 } });
 * ```
 *
 * Read-then-write, with no lock between the two. Vitest runs spec FILES in
 * parallel against one Postgres, and both specs resolve the same org and the
 * same "first" project — so two workers read the same max, compute the same
 * next number, and the loser gets
 * `Unique constraint failed on (org_id, project_id, ticket_number)`.
 *
 * Measured at roughly one run in eight on main. Both specs pass alone every
 * time, which is what makes this expensive: the failure looks like a bug in
 * whatever change happens to be in flight. `vitest.config.ts` already carries a
 * note about a DIFFERENT symptom of the same shared database (timeouts under
 * contention, fixed by raising testTimeout to 30s); this is the other half.
 *
 * The fix is the one production uses: `allocateTicketNumber`, which takes the
 * project's advisory lock for the transaction. An earlier version of this
 * helper retried on the unique violation instead. That made the fixture itself
 * converge, but it never took the lock, so it still raced every production path
 * that does: convert or the work-items route read the max under the lock, the
 * fixture (in another worker) inserted that number first, and the production
 * path, which rightly does not retry, failed with P2002. Observed in
 * `convert.test.ts` under a parallel run of the whole suite.
 */

/**
 * Give a spec's project the statuses its items will sit in.
 *
 * A work item's `column_key` must name one of its project's statuses (a foreign
 * key), and a bare `prisma.project.create` has none. With no `keys`, the
 * project gets the default board's statuses; a key the default board does not
 * have is created as TODO unless `categories` says otherwise. Idempotent.
 */
export async function ensureFixtureStatuses(
  projectId: string,
  keys: readonly string[] = DEFAULT_COLUMNS.map((c) => c.key),
  categories: Partial<Record<string, ColumnCategory>> = {},
): Promise<void> {
  const { orgId } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { orgId: true } });
  const defaults = new Map(DEFAULT_COLUMNS.map((c) => [c.key, c]));
  await ensureStatuses(
    prisma,
    { orgId, projectId },
    keys.map((key, i) => ({
      key,
      name: defaults.get(key)?.name ?? key,
      category: categories[key] ?? defaults.get(key)?.category ?? "TODO",
      sortOrder: defaults.get(key)?.sortOrder ?? 100 + i,
    })),
  );
}

export interface FixtureWorkItemInput {
  orgId: string;
  projectId: string;
  workItemTypeId: string;
  createdById: string;
  title: string;
  columnKey: string;
  description?: string;
}

/**
 * Create a work item with the next ticket number in its project, allocated the
 * way production allocates it: under the project's advisory lock, inside one
 * transaction with the insert, so no other writer, fixture or product code, can
 * take the same number in between.
 */
export async function createFixtureWorkItem(input: FixtureWorkItemInput) {
  await ensureFixtureStatuses(input.projectId, [input.columnKey]);
  return prisma.$transaction(async (tx) => {
    const ticketNumber = await allocateTicketNumber(tx, { orgId: input.orgId, projectId: input.projectId });
    return createWorkItemRow(
      tx,
      {
        data: {
          orgId: input.orgId,
          projectId: input.projectId,
          workItemTypeId: input.workItemTypeId,
          createdById: input.createdById,
          title: input.title,
          description: input.description ?? "",
          columnKey: input.columnKey,
          ticketNumber,
        },
      },
      { actorId: null, source: "SYSTEM" },
    );
  });
}
