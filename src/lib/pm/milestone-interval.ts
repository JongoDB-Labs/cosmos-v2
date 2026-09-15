import { IntervalKind } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { NotFoundError, ConflictError } from "@/lib/rbac/check";

/**
 * Validate a milestone's Program Increment before it is written.
 *
 * A foreign key can only say "interval_id references some interval". It cannot say
 * "…belonging to THIS milestone's project, and only if it is a PROGRAM_INCREMENT" —
 * so Postgres would happily accept a sprint, or a PI from an unrelated project.
 * That is the same gap that let `deliverables.milestone_id` drift across projects.
 * Both halves are therefore checked here, and every write path must call this.
 *
 * Passing `null`/`undefined` clears the link and is always allowed.
 */
export async function assertMilestoneInterval(
  intervalId: string | null | undefined,
  orgId: string,
  projectId: string,
): Promise<void> {
  if (!intervalId) return;

  const interval = await prisma.interval.findFirst({
    where: { id: intervalId, orgId },
    select: { projectId: true, intervalKind: true },
  });

  if (!interval) {
    throw new NotFoundError("Interval not found");
  }
  if (interval.projectId !== projectId) {
    throw new ConflictError("Interval belongs to a different project");
  }
  if (interval.intervalKind !== IntervalKind.PROGRAM_INCREMENT) {
    throw new ConflictError("A milestone can only be tied to a Program Increment");
  }
}
