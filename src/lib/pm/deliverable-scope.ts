import { prisma } from "@/lib/db/client";
import { NotFoundError, ConflictError, type AuthContext } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { mayReadContract } from "@/lib/crm/contract-scope";

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
 * A contract is also CRM data, so the caller must be able to read it, as the
 * contract list would let them (`mayReadContract`). Every contract they can't
 * link gets the same "not found": missing, another org's, another project's,
 * or one they may not read. This used to say "belongs to a different project",
 * which told anyone who could edit a deliverable that the id was a real
 * contract elsewhere.
 *
 * Passing `null`/`undefined` clears the link and is always allowed.
 */
export async function assertDeliverableLinks(
  ctx: AuthContext,
  links: { contractId?: string | null; intervalId?: string | null },
  projectId: string,
): Promise<void> {
  const orgId = ctx.orgId;
  if (links.contractId) {
    const contract = await prisma.contract.findFirst({
      where: { id: links.contractId, orgId },
      select: { projectId: true },
    });
    // A contract with no project yet is accepted: `Contract.projectId` is
    // nullable and a commercial record routinely exists before it is tied to
    // delivery. A contract tied to a DIFFERENT project is a contradiction.
    // `mayReadContract` leaves the CRM bit to the route for an org-level
    // contract, and the deliverable routes don't ask it, so this does.
    const linkable =
      contract !== null &&
      (contract.projectId === null || contract.projectId === projectId) &&
      hasPermission(ctx.permissions, Permission.CRM_READ) &&
      (await mayReadContract(ctx, contract.projectId));
    if (!linkable) throw new NotFoundError("Contract not found");
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

/**
 * Codes that would collide if this contract's deliverables were detached.
 *
 * Deleting a contract sets its deliverables' `contractId` to NULL (the FK's
 * ON DELETE SET NULL). Unassigned deliverables are unique on `(org_id, code)`
 * through a PARTIAL index, so detaching one whose code is already held by an
 * unassigned deliverable violates it — and Postgres raises that from inside
 * the FK's own cascade UPDATE, so the caller sees:
 *
 *   duplicate key value violates unique constraint
 *   "deliverables_org_code_unassigned_key"
 *
 * on a request to delete a CONTRACT. It fails safe — the whole delete rolls
 * back and no row is lost — but as a message it is nonsense from the outside:
 * it names a constraint on a table the caller never mentioned.
 *
 * This is a consequence of scoping item numbers to contracts while keeping
 * today's guarantee for unassigned ones, so the honest fix is to say what is
 * actually in the way rather than to weaken either half.
 */
export async function clashingCodesOnContractDetach(
  orgId: string,
  contractId: string,
): Promise<string[]> {
  const attached = await prisma.deliverable.findMany({
    where: { orgId, contractId },
    select: { code: true },
  });
  if (attached.length === 0) return [];

  const clashes = await prisma.deliverable.findMany({
    where: { orgId, contractId: null, code: { in: attached.map((d) => d.code) } },
    select: { code: true },
  });
  return [...new Set(clashes.map((d) => d.code))].sort();
}
