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

/**
 * May this caller see members' email addresses? A browser session may; an API
 * key only when it holds `members:read`. The rule `respond()` applies through a
 * contract's `scopedFields`, for the routes that answer without a contract.
 */
export function mayReadMemberEmails(ctx: Pick<AuthContext, "isApiKey" | "scopes">): boolean {
  return !ctx.isApiKey || (ctx.scopes ?? []).includes("members:read");
}

export interface MemberDisclosure {
  /** Whether to include email addresses (`mayReadMemberEmails`). */
  emails: boolean;
  /** The roster ceiling as user ids for a query filter; null means no limit. */
  roster: string[] | null;
  /** Whether this person is inside the caller's roster ceiling (`scopedRosterUserIds`). */
  inRoster(userId: string): boolean;
}

/**
 * Both rules every response that lists org members applies: the roster
 * ceiling (who), and email only with `members:read` (what). One call, so a
 * route cannot adopt one and forget the other; `member-disclosure.arch.test.ts`
 * checks every route that sends an email address goes through it or through
 * a contract's `scopedFields`.
 */
export async function memberDisclosure(ctx: AuthContext): Promise<MemberDisclosure> {
  const roster = await scopedRosterUserIds(ctx);
  const allowed = roster ? new Set(roster) : null;
  return {
    emails: mayReadMemberEmails(ctx),
    roster,
    inRoster: (userId) => !allowed || allowed.has(userId),
  };
}
