import { prisma } from "@/lib/db/client";
import { type AuthContext } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { ProjectRole } from "@prisma/client";

/**
 * Inheriting admin hierarchy (system → org → project → board): a check at the
 * org→project boundary. The caller can administer a project — manage its
 * members/roles and (Phase 2) its boards/config — when they EITHER hold
 * org-wide PROJECT_MANAGE (org admins/owners, and system admins who are org
 * owners, inherit downward) OR are a project MANAGER of THAT specific project
 * (a scoped project-admin who is not necessarily an org admin).
 */
export async function canManageProject(
  ctx: AuthContext,
  projectId: string,
): Promise<boolean> {
  // Org-tier (and above) inherit: org-wide project-management permission.
  if (hasPermission(ctx.permissions, Permission.PROJECT_MANAGE)) return true;

  // Project-tier: a MANAGER of this exact project. ProjectMember.orgMemberId is
  // an OrgMember.id (not a User.id), so resolve userId → OrgMember first.
  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId: ctx.orgId, userId: ctx.userId } },
    select: { id: true },
  });
  if (!member) return false;
  const pm = await prisma.projectMember.findFirst({
    where: { projectId, orgMemberId: member.id, role: ProjectRole.MANAGER },
    select: { id: true },
  });
  return pm != null;
}
