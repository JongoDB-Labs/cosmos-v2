import { prisma } from "@/lib/db/client";

/**
 * Resolve the program branches a user is scoped to via a branch-scoped WorkRole
 * assignment — e.g. a "Domain Lead" narrowed to specific branches through
 * `OrgMemberWorkRole.scope = { branchIds: [...] }`. Returns:
 *   - `string[]` → restrict branch-aware register/dashboard queries to these ids
 *   - `null`     → unrestricted (no branch-scoped role assigned)
 *
 * No scoped assignment ⇒ `null`, so admins and ordinary members are never
 * narrowed. Activating a Domain Lead is therefore purely additive: assign the
 * role with a `{ branchIds }` scope (via the work-roles admin) and these
 * helpers do the rest.
 */
export async function resolveBranchScope(
  orgId: string,
  userId: string,
): Promise<string[] | null> {
  const assignments = await prisma.orgMemberWorkRole.findMany({
    where: { orgMember: { orgId, userId } },
    select: { scope: true },
  });

  const branchIds = new Set<string>();
  let scoped = false;
  for (const a of assignments) {
    const scope = a.scope as { branchIds?: unknown } | null;
    if (scope && Array.isArray(scope.branchIds)) {
      scoped = true;
      for (const b of scope.branchIds) if (typeof b === "string") branchIds.add(b);
    }
  }
  return scoped ? Array.from(branchIds) : null;
}

/** A Prisma `where` fragment for a resolved branch scope (spread into a query). */
export function branchScopeWhere(scope: string[] | null): { branchId?: { in: string[] } } {
  return scope ? { branchId: { in: scope } } : {};
}
