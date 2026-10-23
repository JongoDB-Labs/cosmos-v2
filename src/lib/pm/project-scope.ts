/**
 * Which projects a PM read covers: one project (the project tab), a set (the
 * org roll-up, already narrowed to the projects the viewer may see), or the
 * whole org (undefined).
 */
export type PmProjectScope = string | readonly string[] | undefined;

/** The Prisma `where` for a PM read under that scope. */
export function pmScopeWhere(orgId: string, scope: PmProjectScope) {
  if (scope === undefined || scope === "") return { orgId };
  return typeof scope === "string"
    ? { orgId, projectId: scope }
    : { orgId, projectId: { in: [...scope] } };
}
