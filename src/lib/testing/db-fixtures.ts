import { prisma } from "@/lib/db/client";

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
 * await prisma.workItem.create({ data: { ticketNumber: (last?.ticketNumber ?? 0) + 1 } });
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
 * A retry rather than a random high number: random still collides, just rarely
 * enough to be mystifying when it does. Re-reading the max on each attempt
 * converges under any amount of contention, and the offset means two workers
 * retrying in lockstep do not simply collide again.
 */

/** Prisma's code for a unique-constraint violation. */
const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && "code" in e &&
    (e as { code?: unknown }).code === UNIQUE_VIOLATION
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
 * Create a work item with a ticket number that will not collide with a spec
 * running in another worker.
 *
 * Returns the created row. Throws anything that is not a ticket-number
 * collision immediately — a retry loop that swallows real errors would turn a
 * broken fixture into a timeout.
 */
export async function createFixtureWorkItem(
  input: FixtureWorkItemInput,
  attempts = 8,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const last = await prisma.workItem.findFirst({
      where: { projectId: input.projectId },
      orderBy: { ticketNumber: "desc" },
      select: { ticketNumber: true },
    });
    // The offset matters: without it two workers that collide once re-read the
    // same max and collide again on every retry, in lockstep.
    const ticketNumber = (last?.ticketNumber ?? 0) + 1 + attempt;
    try {
      return await prisma.workItem.create({
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
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      lastError = e;
    }
  }
  throw lastError;
}
