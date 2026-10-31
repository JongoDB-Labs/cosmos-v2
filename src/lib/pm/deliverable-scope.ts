import { prisma } from "@/lib/db/client";
import { NotFoundError, ConflictError } from "@/lib/rbac/check";

/**
 * Validate a deliverable's contract and sprint before they are written.
 *
 * A foreign key can only say "this id references some contract / some
 * interval". It cannot say "…in THIS org, and for this deliverable's project",
 * so a client-supplied id would otherwise attach a CDRL to another tenant's
 * contract or another project's sprint. Both halves are checked here and every
 * write path must call this.
 *
 * Contrast `assertMilestoneInterval` (lib/pm/milestone-interval.ts), which ALSO
 * demands `IntervalKind.PROGRAM_INCREMENT`. That constraint is deliberately NOT
 * copied: a CDRL is planned into a sprint, so narrowing the kind here would
 * reject the normal case.
 *
 * Passing `null`/`undefined` clears the link and is always allowed.
 */
export async function assertDeliverableLinks(
  links: { contractId?: string | null; intervalId?: string | null },
  orgId: string,
  projectId: string,
): Promise<void> {
  if (links.contractId) {
    const contract = await prisma.contract.findFirst({
      where: { id: links.contractId, orgId },
      select: { projectId: true },
    });
    if (!contract) throw new NotFoundError("Contract not found");
    // A contract with no project yet is accepted: `Contract.projectId` is
    // nullable and a commercial record routinely exists before it is tied to
    // delivery. A contract tied to a DIFFERENT project is a contradiction.
    if (contract.projectId !== null && contract.projectId !== projectId) {
      throw new ConflictError("Contract belongs to a different project");
    }
  }

  if (links.intervalId) {
    const interval = await prisma.interval.findFirst({
      where: { id: links.intervalId, orgId },
      select: { projectId: true },
    });
    if (!interval) throw new NotFoundError("Interval not found");
    if (interval.projectId !== projectId) {
      throw new ConflictError("Interval belongs to a different project");
    }
  }
}
