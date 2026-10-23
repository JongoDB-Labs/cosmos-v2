/**
 * Discussion on feedback items (bug reports and feature requests).
 *
 * Stored in the polymorphic Comment table (subjectType "feedback"), like the
 * PM-register and file comments: no second table for the same concept.
 *
 * THE single place feedback comments are read and shaped for a viewer. Every
 * route (and later the assistant and exports) goes through listFeedbackComments,
 * so visibility is decided once: internal notes never reach someone who is not
 * on the feedback team, whatever surface asks.
 */
import type { CommentKind, CommentVisibility, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { uploadersByIds, FORMER_MEMBER, type Uploader } from "@/lib/files/uploader";
import { parseMentions } from "@/lib/chat/mentions";
import { mentionsToPlainText, userMentionLabels } from "@/lib/mentions/plain-text";
import { createNotification } from "@/lib/notifications/create";
import { feedbackItemUrl } from "./urls";

import { FEEDBACK_SUBJECT } from "./subject";

export { FEEDBACK_SUBJECT };

export interface CommentViewer {
  userId: string;
  /** On the feedback team (isFeedbackStaff). */
  isStaff: boolean;
}

/** Which comments a viewer may see at all. Internal notes are staff-only. */
export function visibleTo(viewer: CommentViewer): Prisma.CommentWhereInput {
  return viewer.isStaff ? {} : { visibility: "PUBLIC" };
}

export const FEEDBACK_COMMENT_SELECT = {
  id: true,
  parentId: true,
  authorId: true,
  content: true,
  kind: true,
  visibility: true,
  meta: true,
  createdAt: true,
  editedAt: true,
  deletedAt: true,
  originSubjectId: true,
  _count: { select: { revisions: true } },
} as const;

export type FeedbackCommentRow = Prisma.CommentGetPayload<{ select: typeof FEEDBACK_COMMENT_SELECT }>;

export interface FeedbackCommentDto {
  id: string;
  parentId: string | null;
  kind: CommentKind;
  visibility: CommentVisibility;
  /** Null once deleted: the tombstone never carries the words. */
  content: string | null;
  deleted: boolean;
  /** Null on a deleted comment for non-staff (only staff see who it was). */
  author: Uploader | null;
  createdAt: Date;
  editedAt: Date | null;
  revisionCount: number;
  /** Set when a merge moved this comment here from another request. */
  originSubjectId: string | null;
  canEdit: boolean;
  canDelete: boolean;
  replies: FeedbackCommentDto[];
}

function toDto(
  row: FeedbackCommentRow,
  viewer: CommentViewer,
  authors: Map<string, Uploader>,
): FeedbackCommentDto {
  const deleted = row.deletedAt !== null;
  const mine = row.authorId === viewer.userId;
  const author = authors.get(row.authorId) ?? { id: row.authorId, ...FORMER_MEMBER };
  return {
    id: row.id,
    parentId: row.parentId,
    kind: row.kind,
    visibility: row.visibility,
    content: deleted ? null : row.content,
    deleted,
    author: deleted && !viewer.isStaff ? null : author,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    revisionCount: row._count.revisions,
    originSubjectId: row.originSubjectId,
    canEdit: !deleted && mine && row.kind === "COMMENT",
    canDelete: !deleted && (mine || viewer.isStaff) && row.kind !== "STATUS_CHANGE",
    replies: [],
  };
}

/**
 * Rows (oldest first) → the thread a viewer sees. One level of replies; a reply
 * whose parent is not in view becomes top-level rather than vanishing. A deleted
 * comment stays only as a tombstone, and only while it still has visible
 * replies; a deleted reply simply leaves.
 */
export function buildThread(
  rows: FeedbackCommentRow[],
  viewer: CommentViewer,
  authors: Map<string, Uploader>,
): FeedbackCommentDto[] {
  const ids = new Set(rows.map((r) => r.id));
  const top: FeedbackCommentDto[] = [];
  const replies = new Map<string, FeedbackCommentDto[]>();
  for (const row of rows) {
    const dto = toDto(row, viewer, authors);
    if (row.parentId && ids.has(row.parentId)) {
      if (dto.deleted) continue;
      const list = replies.get(row.parentId) ?? [];
      list.push(dto);
      replies.set(row.parentId, list);
    } else {
      top.push(dto);
    }
  }
  return top
    .map((c) => ({ ...c, replies: replies.get(c.id) ?? [] }))
    .filter((c) => !c.deleted || c.replies.length > 0);
}

export async function listFeedbackComments(
  orgId: string,
  feedbackItemId: string,
  viewer: CommentViewer,
): Promise<FeedbackCommentDto[]> {
  const rows = await prisma.comment.findMany({
    where: { orgId, subjectType: FEEDBACK_SUBJECT, subjectId: feedbackItemId, ...visibleTo(viewer) },
    orderBy: { createdAt: "asc" },
    select: FEEDBACK_COMMENT_SELECT,
  });
  const authors = await uploadersByIds(rows.map((r) => r.authorId));
  return buildThread(rows, viewer, authors);
}

/** One comment, as this viewer may see it, or null if they may not. */
export async function getFeedbackComment(
  orgId: string,
  feedbackItemId: string,
  commentId: string,
  viewer: CommentViewer,
) {
  return prisma.comment.findFirst({
    where: {
      id: commentId,
      orgId,
      subjectType: FEEDBACK_SUBJECT,
      subjectId: feedbackItemId,
      ...visibleTo(viewer),
    },
  });
}

/**
 * Where a new reply attaches: one level only, so replying to a reply joins the
 * same top-level comment. Null when the parent is not a live, visible comment
 * on this item.
 */
export async function resolveReplyParent(
  orgId: string,
  feedbackItemId: string,
  parentId: string,
  viewer: CommentViewer,
): Promise<{ id: string; authorId: string } | null> {
  const parent = await getFeedbackComment(orgId, feedbackItemId, parentId, viewer);
  if (!parent || parent.deletedAt) return null;
  if (!parent.parentId) return { id: parent.id, authorId: parent.authorId };
  const top = await getFeedbackComment(orgId, feedbackItemId, parent.parentId, viewer);
  return top && !top.deletedAt
    ? { id: top.id, authorId: parent.authorId }
    : { id: parent.id, authorId: parent.authorId };
}

/** Write a public comment and keep the item's counters in step. */
export async function insertFeedbackComment(
  tx: Prisma.TransactionClient,
  input: {
    orgId: string;
    feedbackItemId: string;
    authorId: string;
    content: string;
    parentId: string | null;
  },
) {
  const comment = await tx.comment.create({
    data: {
      orgId: input.orgId,
      subjectType: FEEDBACK_SUBJECT,
      subjectId: input.feedbackItemId,
      authorId: input.authorId,
      content: input.content,
      parentId: input.parentId,
      visibility: "PUBLIC",
      kind: "COMMENT",
    },
    select: FEEDBACK_COMMENT_SELECT,
  });
  await tx.feedbackItem.update({
    where: { id: input.feedbackItemId },
    data: { commentCount: { increment: 1 }, lastActivityAt: comment.createdAt },
  });
  return comment;
}

/**
 * After the comment commits: tell the people it was addressed to. Mentions of
 * org members, and the author of the comment replied
 * to. The writer is never notified; nobody is notified twice. Best-effort.
 */
export async function notifyCommentAudience(input: {
  org: { id: string; slug: string };
  item: { id: string; title: string };
  comment: { id: string; content: string; authorId: string };
  /** Only these mention ids are new (an edit notifies only who it added). */
  mentionIds?: string[];
  repliedToUserId?: string | null;
}): Promise<void> {
  const { org, item, comment } = input;
  const url = `${feedbackItemUrl(org.slug, item.id)}#c-${comment.id}`;
  const wanted = input.mentionIds ?? parseMentions(comment.content);
  const members = wanted.length
    ? await prisma.orgMember.findMany({
        where: { orgId: org.id, userId: { in: wanted } },
        select: { userId: true, user: { select: { displayName: true } } },
      })
    : [];
  const labels = userMentionLabels(
    members
      .filter((m) => m.user?.displayName)
      .map((m) => ({ id: m.userId, displayName: m.user!.displayName })),
  );
  const snippet = mentionsToPlainText(comment.content, labels).slice(0, 200);
  const notified = new Set<string>([comment.authorId]);

  for (const m of members) {
    if (notified.has(m.userId)) continue;
    notified.add(m.userId);
    await createNotification({
      orgId: org.id,
      userId: m.userId,
      type: "feedback.comment.mentioned",
      title: `Mentioned on "${item.title}"`,
      message: snippet,
      relatedId: item.id,
      relatedType: "feedback_item",
      url,
    }).catch(() => {});
  }

  const repliedTo = input.repliedToUserId;
  if (repliedTo && !notified.has(repliedTo)) {
    await createNotification({
      orgId: org.id,
      userId: repliedTo,
      type: "feedback.comment.replied",
      title: `New reply on "${item.title}"`,
      message: snippet,
      relatedId: item.id,
      relatedType: "feedback_item",
      url,
    }).catch(() => {});
  }
}

/** Shape one freshly written comment for its author (always theirs to edit). */
export async function feedbackCommentDto(row: FeedbackCommentRow, viewer: CommentViewer) {
  const authors = await uploadersByIds([row.authorId]);
  return toDto(row, viewer, authors);
}
