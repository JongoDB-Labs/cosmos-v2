import { prisma } from "@/lib/db/client";
import { NotFoundError } from "@/lib/rbac/check";

/**
 * Assert that a user referenced by a request body actually belongs to the org.
 *
 * WHY THIS EXISTS. Any endpoint that accepts a *user id from the client* and
 * stores it on an org-scoped row is a cross-tenant hole unless it checks
 * membership: user ids are UUIDs, but they are not secret, and nothing else in
 * the write path constrains them to the caller's org. Assigning a deliverable
 * to a user in a different tenant would leak that user's existence, name and
 * avatar back through the assignee DTO.
 *
 * NotFoundError rather than ForbiddenError on purpose: to a caller who is not
 * in that org, a user of another org must be indistinguishable from a user who
 * does not exist. A 403 would confirm the id is real.
 */
export async function assertOrgMember(orgId: string, userId: string): Promise<void> {
  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    select: { id: true },
  });
  if (!member) throw new NotFoundError("User is not a member of this organization");
}
