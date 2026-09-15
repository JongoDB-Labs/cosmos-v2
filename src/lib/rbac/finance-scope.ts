import { prisma } from "@/lib/db/client";
import { Permission, hasPermission } from "./permissions";
import type { AuthContext } from "./check";

/**
 * Which projects' money a reader may see.
 *
 * Money used to be one bit: FINANCE_READ, the whole practice's book. That made
 * a project manager either blind to the fee they are managing to, or an org
 * admin with user management and audit logs attached — and firms pick the
 * second, which is how a delivery tool ends up with everybody as an admin.
 */
export type MoneyScope =
  | { kind: "org" }
  | { kind: "projects"; ids: ReadonlySet<string> }
  | { kind: "none" };

/**
 * Resolve what this reader may see. Hits the database ONLY for the narrow
 * grant, so the common org-wide and no-access answers stay free.
 */
export async function financeScope(ctx: AuthContext): Promise<MoneyScope> {
  if (hasPermission(ctx.permissions, Permission.FINANCE_READ)) return { kind: "org" };
  if (!hasPermission(ctx.permissions, Permission.FINANCE_READ_PROJECT)) return { kind: "none" };

  const rows = await prisma.projectMember.findMany({
    where: { orgMember: { orgId: ctx.orgId, userId: ctx.userId } },
    select: { projectId: true },
  });
  return { kind: "projects", ids: new Set(rows.map((r) => r.projectId)) };
}

/**
 * Whether a scope covers one project.
 *
 * An unknown project is refused under the narrow grant: membership cannot be
 * confirmed, and the failure to confirm must not read as permission.
 */
export function scopeCovers(scope: MoneyScope, projectId: string | null | undefined): boolean {
  switch (scope.kind) {
    case "org":
      return true;
    case "none":
      return false;
    case "projects":
      return projectId != null && scope.ids.has(projectId);
  }
}
