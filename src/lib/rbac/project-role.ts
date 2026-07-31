import { prisma } from "@/lib/db/client";
import { type AuthContext } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { ProjectRole } from "@prisma/client";

/**
 * What a person's PROJECT role means, on top of their org permissions.
 *
 * It previously meant nothing below MANAGER: `ProjectRole` appeared exactly
 * twice in all of src/, both `MANAGER`, while the Members picker offered four
 * levels. A role enum that looks enforced and is not is worse than no enum —
 * someone sets a colleague to VIEWER, believes they cannot edit, and they can.
 *
 *   MANAGER  administer the project and its members   (unchanged)
 *   LEAD     MEMBER, plus board management            (grants only)
 *   MEMBER   defer entirely to org permissions        (unchanged)
 *   VIEWER   read-only in THIS project                (nobody holds it today)
 *
 * Chosen against the live distribution deliberately: the only RESTRICTING rule
 * lands on VIEWER, which no row currently has, and the only role that changes
 * for real people — LEAD — can gain but never lose. Nobody's access narrows.
 *
 * These narrow WITHIN a grant the actor already holds; they never widen one.
 * A project role cannot hand out a permission the org withheld.
 */

/** The actor's role on this project, or null if they are not a member of it. */
async function roleOn(ctx: AuthContext, projectId: string): Promise<ProjectRole | null> {
  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId: ctx.orgId, userId: ctx.userId } },
    select: { id: true },
  });
  if (!member) return null;
  const pm = await prisma.projectMember.findFirst({
    where: { projectId, orgMemberId: member.id },
    select: { role: true },
  });
  return pm?.role ?? null;
}

/** Org-wide project administration inherits downward, as everywhere else. */
function inheritsAdmin(ctx: AuthContext): boolean {
  return ctx.orgRole === "OWNER" || hasPermission(ctx.permissions, Permission.PROJECT_MANAGE);
}

/**
 * May this actor WRITE in this project, given they already hold the relevant
 * org bit? Only VIEWER answers no.
 *
 * A non-member is unaffected: project roles constrain the people ON a project.
 * Whether a non-member may act at all is the visibility question, decided by
 * project-access.ts — this must not quietly become a second membership gate.
 */
export async function canWriteInProject(
  ctx: AuthContext,
  projectId: string,
  required: bigint = Permission.ITEM_UPDATE,
): Promise<boolean> {
  if (!hasPermission(ctx.permissions, required)) return false;
  if (inheritsAdmin(ctx)) return true;
  return (await roleOn(ctx, projectId)) !== ProjectRole.VIEWER;
}

/**
 * May this actor manage the project's boards?
 *
 * LEAD and MANAGER may, by virtue of the role. Everyone else falls back to the
 * org bit they would have been judged on before, so no one loses anything.
 */
export async function canManageBoardsInProject(
  ctx: AuthContext,
  projectId: string,
): Promise<boolean> {
  if (inheritsAdmin(ctx)) return true;
  const role = await roleOn(ctx, projectId);
  if (role === ProjectRole.MANAGER || role === ProjectRole.LEAD) return true;
  if (role === ProjectRole.VIEWER) return false;
  return hasPermission(ctx.permissions, Permission.BOARD_CREATE);
}
