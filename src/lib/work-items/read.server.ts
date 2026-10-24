import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { canManageProject } from "@/lib/rbac/scope";
import { Permission } from "@/lib/rbac/permissions";

/**
 * The work-item reads behind both addresses of an item: the project-scoped
 * route (`/projects/{projectId}/work-items/{itemId}`) and the org-scoped one
 * (`/work-items/{itemId}`). One implementation, so the two can't drift. The
 * caller has already authenticated and checked the project read gate.
 */

const parent = { select: { id: true, title: true, ticketNumber: true, workItemTypeId: true } } as const;
const workItemType = { select: { id: true, key: true, name: true, icon: true, color: true } } as const;
const assignees = {
  orderBy: { sortOrder: "asc" },
  select: {
    userId: true,
    user: { select: { id: true, displayName: true, avatarUrl: true } },
  },
} as const;

/** One item with its relations, first 50 comments and 50 latest changes; null if it isn't in this project. */
export function loadWorkItemDetail(orgId: string, projectId: string, itemId: string) {
  return prisma.workItem.findFirst({
    where: { id: itemId, orgId, projectId },
    // Full-text index internals, never part of the response (schemas.test).
    omit: { searchVector: true },
    include: {
      parent,
      children: { select: { id: true, title: true, columnKey: true, ticketNumber: true, workItemTypeId: true, completedAt: true }, orderBy: { sortOrder: "asc" } },
      comments: { orderBy: { createdAt: "asc" }, take: 50 },
      activities: { orderBy: { createdAt: "desc" }, take: 50 },
      workItemType,
      interval: { select: { id: true, name: true, number: true, status: true } },
      assignees,
    },
  });
}

/**
 * The item's comment thread, oldest first, with each author's name and what
 * the caller may do with each comment; null if the item isn't in this project.
 *
 * Comment has no User relation, so authors are a side query. Deleting someone
 * else's comment is moderation: the caller's role counts only when it would
 * pass ITEM_DELETE (a key's role counts only if its scopes grant that).
 */
export async function loadWorkItemComments(ctx: AuthContext, orgId: string, projectId: string, itemId: string) {
  const item = await prisma.workItem.findFirst({ where: { id: itemId, orgId, projectId }, select: { id: true } });
  if (!item) return null;

  const comments = await prisma.comment.findMany({
    where: { workItemId: itemId, orgId },
    orderBy: { createdAt: "asc" },
  });
  const authorIds = [...new Set(comments.map((c) => c.authorId))];
  const authors = authorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: authorIds } },
        select: { id: true, displayName: true, avatarUrl: true },
      })
    : [];
  const authorById = new Map(authors.map((u) => [u.id, u]));
  const isManager = await canManageProject(ctx, projectId, Permission.ITEM_DELETE);

  return comments.map((c) => ({
    ...c,
    authorName: authorById.get(c.authorId)?.displayName ?? null,
    authorAvatarUrl: authorById.get(c.authorId)?.avatarUrl ?? null,
    canEdit: c.authorId === ctx.userId,
    canDelete: c.authorId === ctx.userId || isManager,
  }));
}

/** The project an item belongs to, found by its org-wide id; null if it isn't in this org. */
export async function workItemProjectId(orgId: string, itemId: string): Promise<string | null> {
  const item = await prisma.workItem.findFirst({ where: { id: itemId, orgId }, select: { projectId: true } });
  return item?.projectId ?? null;
}
