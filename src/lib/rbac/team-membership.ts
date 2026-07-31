import { prisma } from "@/lib/db/client";
import { type AuthContext } from "@/lib/rbac/check";

/**
 * The teams this actor belongs to within a project.
 *
 * TeamMember points at ProjectMember, so this resolves
 * userId -> OrgMember -> ProjectMember -> TeamMember. Someone who is not on the
 * project is on none of its teams, which falls out naturally rather than needing
 * a special case.
 *
 * Returns [] for a non-member, which `visibleBoards` reads as "shared boards
 * only" — the safe direction.
 */
export async function teamIdsForActor(
  ctx: AuthContext,
  projectId: string,
): Promise<string[]> {
  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId: ctx.orgId, userId: ctx.userId } },
    select: { id: true },
  });
  if (!member) return [];
  const rows = await prisma.teamMember.findMany({
    where: { projectMember: { projectId, orgMemberId: member.id } },
    select: { teamId: true },
  });
  return rows.map((r) => r.teamId);
}
