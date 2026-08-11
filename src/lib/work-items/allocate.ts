import type { Prisma } from "@prisma/client";

/**
 * Allocation shared by every path that creates a work item.
 *
 * A second creation path is how two callers come to disagree about what a new
 * item looks like — one numbers tickets differently, another lands items on top
 * of a column instead of the bottom. Both callers here (the work-items route and
 * retro action-item promotion) go through these.
 *
 * Both take a transaction client: the read and the insert that depends on it
 * must not be separated, or two concurrent creates collide on the same number.
 */

type Tx = Prisma.TransactionClient;

/** Next ticket number for a project — `PRJ-<n>` counts up per project. */
export async function allocateTicketNumber(
  tx: Tx,
  where: { orgId: string; projectId: string }
): Promise<number> {
  const max = await tx.workItem.aggregate({
    where,
    _max: { ticketNumber: true },
  });
  return (max._max.ticketNumber ?? 0) + 1;
}

/** Next sort position at the BOTTOM of a column, where new work belongs. */
export async function allocateSortOrder(
  tx: Tx,
  where: { orgId: string; projectId: string; columnKey: string }
): Promise<number> {
  const max = await tx.workItem.aggregate({
    where,
    _max: { sortOrder: true },
  });
  return (max._max.sortOrder ?? -1) + 1;
}
