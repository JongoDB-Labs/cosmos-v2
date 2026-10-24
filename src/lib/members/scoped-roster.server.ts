import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";

/**
 * Who a project-scoped API key may see in the member roster (the member list
 * and the work-item filters' members).
 *
 * Scopes narrow access: a key limited to some projects is what goes to a
 * contractor or a single-project integration, and the org's roster lies outside
 * those projects. In a gov tenant who works here is itself information. So such
 * a key sees only the people tied to the projects it can read: their project
 * members, and the assignees, creators and commenters of their items.
 *
 * Null means no narrowing: a browser session, or a key without a project
 * scope (org-wide). Emails stay gated by `members:read` either way.
 */
export async function scopedRosterUserIds(ctx: AuthContext): Promise<string[] | null> {
  if (!ctx.isApiKey || !ctx.projectScope?.length) return null;
  const projectIds = await getReadableProjectIds(ctx);
  if (projectIds.length === 0) return [];

  const inProjects = { orgId: ctx.orgId, projectId: { in: projectIds } };
  const [members, creators, primaries, assignees, commenters] = await Promise.all([
    prisma.projectMember.findMany({
      where: { projectId: { in: projectIds } },
      select: { orgMember: { select: { userId: true } } },
    }),
    prisma.workItem.findMany({ where: inProjects, select: { createdById: true }, distinct: ["createdById"] }),
    prisma.workItem.findMany({
      where: { ...inProjects, assigneeId: { not: null } },
      select: { assigneeId: true },
      distinct: ["assigneeId"],
    }),
    prisma.workItemAssignee.findMany({ where: { workItem: inProjects }, select: { userId: true }, distinct: ["userId"] }),
    prisma.comment.findMany({
      where: { orgId: ctx.orgId, workItem: { projectId: { in: projectIds } } },
      select: { authorId: true },
      distinct: ["authorId"],
    }),
  ]);

  return [
    ...new Set([
      ...members.map((m) => m.orgMember.userId),
      ...creators.map((r) => r.createdById),
      ...primaries.flatMap((r) => (r.assigneeId ? [r.assigneeId] : [])),
      ...assignees.map((r) => r.userId),
      ...commenters.map((r) => r.authorId),
    ]),
  ];
}
