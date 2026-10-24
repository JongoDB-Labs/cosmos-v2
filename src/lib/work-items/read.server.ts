import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { ForbiddenError, type AuthContext } from "@/lib/rbac/check";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { canManageProject } from "@/lib/rbac/scope";
import { Permission } from "@/lib/rbac/permissions";
import { markingCeiling } from "@/lib/feedback/comments.server";
import { levelsReadableUnder } from "@/lib/feedback/marking";

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

/**
 * The comments a work-item read returns. Work-item threads have no staff
 * audience, so they carry what anyone may read: public, neither deleted nor
 * hidden, and marked no higher than the org's ceiling covers (the feedback
 * thread's rule for a non-staff reader). Comments written on work items are
 * all of that today; a comment that arrives otherwise (a merge, a later
 * feature) stays out of the API rather than leaking its content.
 */
export async function readableCommentsWhere(orgId: string): Promise<Prisma.CommentWhereInput> {
  return {
    visibility: "PUBLIC",
    deletedAt: null,
    hiddenAt: null,
    OR: [{ classification: null }, { classification: { in: levelsReadableUnder(await markingCeiling(orgId)) } }],
  };
}

/** Whether the caller passes the project gate for `action`; any other error still throws. */
async function mayRead(ctx: AuthContext, projectId: string, action: "ITEM_READ" | "COMMENT_READ") {
  return requireProjectRead(ctx, projectId, action).then(
    () => true,
    (e) => {
      if (e instanceof ForbiddenError) return false;
      throw e;
    },
  );
}

/**
 * One item with its relations, its first 50 readable comments (only for a
 * caller who may read the project's comments; none otherwise) and its 50
 * latest changes. Null if it isn't in this project.
 */
export async function loadWorkItemDetail(ctx: AuthContext, orgId: string, projectId: string, itemId: string) {
  const withComments = await mayRead(ctx, projectId, "COMMENT_READ");
  const item = await prisma.workItem.findFirst({
    where: { id: itemId, orgId, projectId },
    // Full-text index internals, never part of the response (schemas.test).
    omit: { searchVector: true },
    include: {
      parent,
      children: { select: { id: true, title: true, columnKey: true, ticketNumber: true, workItemTypeId: true, completedAt: true }, orderBy: { sortOrder: "asc" } },
      comments: withComments
        ? { where: await readableCommentsWhere(orgId), orderBy: { createdAt: "asc" }, take: 50 }
        : false,
      activities: { orderBy: { createdAt: "desc" }, take: 50 },
      workItemType,
      interval: { select: { id: true, name: true, number: true, status: true } },
      assignees,
    },
  });
  if (!item) return null;
  return { ...item, comments: item.comments ?? [], activities: projectActivityValues(item.activities) };
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
    where: { workItemId: itemId, orgId, ...(await readableCommentsWhere(orgId)) },
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

/**
 * For the org-scoped address: the project of an item the caller may read with
 * `action`, or null. An item in a project the caller can't read is null too,
 * so the route answers the same 404 as for an id that doesn't exist and a
 * signed-in caller can't learn which ids exist elsewhere in the org.
 */
export async function readableItemProjectId(
  ctx: AuthContext,
  orgId: string,
  itemId: string,
  action: "ITEM_READ" | "COMMENT_READ",
): Promise<string | null> {
  const item = await prisma.workItem.findFirst({ where: { id: itemId, orgId }, select: { projectId: true } });
  if (!item) return null;
  return (await mayRead(ctx, item.projectId, action)) ? item.projectId : null;
}

/**
 * The fields whose before/after values a work item's change history returns.
 * Each is a field of the item itself, readable by anyone who can read the
 * item: what the writers record today (apply-change, the schedule cascade,
 * merge). A change to any other field still appears, with its values null,
 * until it is reviewed and added here, so a future writer that records, say,
 * a description or a rate can't publish it through the history.
 */
export const ACTIVITY_VALUE_FIELDS: ReadonlySet<string> = new Set([
  "title", "columnKey", "priority", "assigneeId", "resolution", "intervalId", "teamId",
  "workItemTypeId", "cancelReason", "transition", "startDate", "dueDate", "mergedIntoId", "mergedFrom",
]);

/** Activity rows as the history returns them: values only for ACTIVITY_VALUE_FIELDS. */
export function projectActivityValues<T extends { field: string | null; oldValue: string | null; newValue: string | null }>(
  rows: T[],
): T[] {
  return rows.map((r) =>
    r.field === null || ACTIVITY_VALUE_FIELDS.has(r.field) ? r : { ...r, oldValue: null, newValue: null },
  );
}

