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
import type { ClassificationLevel, CommentKind, CommentVisibility, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { uploadersByIds, FORMER_MEMBER, type Uploader } from "@/lib/files/uploader";
import { parseMentions } from "@/lib/chat/mentions";
import { mentionsToPlainText, userMentionLabels } from "@/lib/mentions/plain-text";
import { createNotification } from "@/lib/notifications/create";
import { feedbackItemUrl } from "./urls";
import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { isFeedbackStaff } from "./access";
import { effectiveCeiling } from "@/lib/classification/effective";
import { logAudit } from "@/lib/audit";
import { levelsReadableUnder, markingAllowed, markingForcesInternal } from "./marking";

import { FEEDBACK_SUBJECT } from "./subject";
import { activeSubscriberIds, ensureSubscribed } from "./subscriptions.server";

export { FEEDBACK_SUBJECT };

export interface CommentViewer {
  userId: string;
  /** On the feedback team (isFeedbackStaff). */
  isStaff: boolean;
  /**
   * The org's marking ceiling right now (markingCeiling). A marked comment is
   * weighed against it on every read, so lowering the ceiling hides what it
   * no longer covers at once, with no sweep.
   */
  markingCeiling: ClassificationLevel;
}

/**
 * Which comments a viewer may see at all. Internal notes are staff-only, and
 * so is a public comment marked above what the org's ceiling covers today.
 */
export function visibleTo(viewer: CommentViewer): Prisma.CommentWhereInput {
  if (viewer.isStaff) return {};
  return {
    visibility: "PUBLIC",
    OR: [{ classification: null }, { classification: { in: levelsReadableUnder(viewer.markingCeiling) } }],
  };
}

/** Staff can narrow the thread to one audience; everyone else sees public. */
export type ThreadFilter = "all" | "public" | "internal";

function filterWhere(viewer: CommentViewer, filter: ThreadFilter): Prisma.CommentWhereInput {
  if (!viewer.isStaff) return visibleTo(viewer);
  if (filter === "public") return { visibility: "PUBLIC" };
  return filter === "internal" ? { visibility: "INTERNAL" } : {};
}

/**
 * Which of these people are on the feedback team right now. Read fresh, never
 * from the comment: an internal note must not reach someone who has since
 * lost the role.
 */
export async function currentStaff(orgId: string, userIds: string[]): Promise<Set<string>> {
  return whoCan(orgId, userIds, isFeedbackStaff);
}

/**
 * Which of these people can read the board right now (members holding
 * ORG_READ). Someone who left the org, or lost the read, hears nothing more.
 */
export async function currentReaders(orgId: string, userIds: string[]): Promise<Set<string>> {
  return whoCan(orgId, userIds, (eff) => hasPermission(eff.permissions, Permission.ORG_READ));
}

/** How many permission loads run at once: well under the connection pool. */
const PERMISSION_BATCH = 20;

/**
 * Everyone whose current effective permissions pass `test`, loaded in parallel
 * batches, so a busy item's followers can't take every pooled connection.
 */
async function whoCan(
  orgId: string,
  userIds: string[],
  test: (eff: { permissions: bigint }) => boolean,
): Promise<Set<string>> {
  const ids = [...new Set(userIds)];
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += PERMISSION_BATCH) {
    const batch = ids.slice(i, i + PERMISSION_BATCH);
    const effs = await Promise.all(batch.map((id) => loadEffectivePermissions(orgId, id)));
    batch.forEach((id, j) => {
      if (effs[j] && test(effs[j]!)) out.add(id);
    });
  }
  return out;
}

export const FEEDBACK_COMMENT_SELECT = {
  id: true,
  parentId: true,
  authorId: true,
  content: true,
  kind: true,
  visibility: true,
  classification: true,
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
  /** Opt-in marking (gov tenants); null when unmarked. */
  classification: ClassificationLevel | null;
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
    classification: row.classification,
    content: deleted ? null : row.content,
    deleted,
    author: deleted && !viewer.isStaff ? null : author,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    revisionCount: row._count.revisions,
    originSubjectId: row.originSubjectId,
    canEdit: !deleted && mine && canEditKind(row.kind, viewer),
    canDelete: !deleted && (mine || viewer.isStaff) && row.kind !== "STATUS_CHANGE",
    replies: [],
  };
}

/**
 * Which kinds an author may rewrite. The pinned official response speaks for
 * the team, so while it is pinned only staff edit it: a member whose comment
 * was pinned can edit it again once it is unpinned.
 */
export function canEditKind(kind: CommentKind, viewer: CommentViewer): boolean {
  return kind === "COMMENT" || (kind === "OFFICIAL" && viewer.isStaff);
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
  filter: ThreadFilter = "all",
): Promise<FeedbackCommentDto[]> {
  const rows = await prisma.comment.findMany({
    where: { orgId, subjectType: FEEDBACK_SUBJECT, subjectId: feedbackItemId, ...filterWhere(viewer, filter) },
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
): Promise<{ id: string; authorId: string; visibility: CommentVisibility } | null> {
  const parent = await getFeedbackComment(orgId, feedbackItemId, parentId, viewer);
  if (!parent || parent.deletedAt) return null;
  if (!parent.parentId) return { id: parent.id, authorId: parent.authorId, visibility: parent.visibility };
  const top = await getFeedbackComment(orgId, feedbackItemId, parent.parentId, viewer);
  return top && !top.deletedAt
    ? { id: top.id, authorId: parent.authorId, visibility: top.visibility }
    : { id: parent.id, authorId: parent.authorId, visibility: parent.visibility };
}

/**
 * Write a comment and keep the item in step. Only PUBLIC comments count or
 * move "last activity": an internal note must not show up as a number or a
 * timestamp to people who can't read it. An OFFICIAL response becomes the
 * item's pinned answer, replacing any earlier one. The writer follows the
 * item from now on.
 */
export async function insertFeedbackComment(
  tx: Prisma.TransactionClient,
  input: {
    orgId: string;
    feedbackItemId: string;
    authorId: string;
    content: string;
    parentId: string | null;
    visibility?: CommentVisibility;
    kind?: "COMMENT" | "OFFICIAL";
    classification?: ClassificationLevel | null;
  },
) {
  const visibility = input.visibility ?? "PUBLIC";
  const kind = input.kind ?? "COMMENT";
  const comment = await tx.comment.create({
    data: {
      orgId: input.orgId,
      subjectType: FEEDBACK_SUBJECT,
      subjectId: input.feedbackItemId,
      authorId: input.authorId,
      content: input.content,
      parentId: input.parentId,
      visibility,
      kind,
      classification: input.classification ?? null,
    },
    select: FEEDBACK_COMMENT_SELECT,
  });
  if (visibility === "PUBLIC") {
    await tx.feedbackItem.update({
      where: { id: input.feedbackItemId },
      data: { commentCount: { increment: 1 }, lastActivityAt: comment.createdAt },
    });
  }
  if (kind === "OFFICIAL") await pinOfficial(tx, input.feedbackItemId, comment.id);
  await ensureSubscribed(tx, {
    orgId: input.orgId,
    feedbackItemId: input.feedbackItemId,
    userId: input.authorId,
    reason: "commenter",
  });
  return comment;
}

/** Make this comment the item's official response; the previous one steps down. */
async function pinOfficial(tx: Prisma.TransactionClient, feedbackItemId: string, commentId: string) {
  const item = await tx.feedbackItem.findUniqueOrThrow({
    where: { id: feedbackItemId },
    select: { officialCommentId: true },
  });
  if (item.officialCommentId && item.officialCommentId !== commentId) {
    await tx.comment.update({ where: { id: item.officialCommentId }, data: { kind: "COMMENT" } });
  }
  await tx.comment.update({ where: { id: commentId }, data: { kind: "OFFICIAL" } });
  await tx.feedbackItem.update({ where: { id: feedbackItemId }, data: { officialCommentId: commentId } });
}

/**
 * The ceiling a comment's marking is weighed against: the org's own on a gov
 * tenant. Anywhere else nothing is cleared above unclassified, so a marking
 * left over from a gov past stays with the team.
 */
export async function markingCeiling(orgId: string): Promise<ClassificationLevel> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { tenantClass: true } });
  return org?.tenantClass === "GOV" ? effectiveCeiling(orgId) : "UNCLASSIFIED";
}

/**
 * Whether this org's staff can mark comments, and the org ceiling the marking
 * is weighed against. Null outside gov tenants: markings are a gov control.
 */
export async function commentMarkingPolicy(orgId: string): Promise<{ orgCeiling: ClassificationLevel } | null> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { tenantClass: true } });
  if (org?.tenantClass !== "GOV") return null;
  return { orgCeiling: await effectiveCeiling(orgId) };
}

export class CommentChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommentChangeError";
  }
}

/**
 * Staff: pin a public top-level comment as the official response, or unpin
 * the current one.
 */
export async function setOfficial(
  tx: Prisma.TransactionClient,
  input: { orgId: string; feedbackItemId: string; commentId: string; official: boolean },
) {
  const c = await tx.comment.findUniqueOrThrow({
    where: { id: input.commentId },
    select: { parentId: true, visibility: true, deletedAt: true, kind: true, classification: true },
  });
  if (input.official) {
    if (c.deletedAt || c.parentId || c.visibility !== "PUBLIC" || (c.kind !== "COMMENT" && c.kind !== "OFFICIAL")) {
      throw new CommentChangeError("Only a public top-level comment can be the official response.");
    }
    if (c.classification && markingForcesInternal(c.classification, await markingCeiling(input.orgId))) {
      throw new CommentChangeError("This comment is marked above what the whole org may read, so it can't be the official response.");
    }
    await pinOfficial(tx, input.feedbackItemId, input.commentId);
    return;
  }
  if (c.kind === "OFFICIAL") {
    await tx.comment.update({ where: { id: input.commentId }, data: { kind: "COMMENT" } });
    await tx.feedbackItem.updateMany({
      where: { id: input.feedbackItemId, officialCommentId: input.commentId },
      data: { officialCommentId: null },
    });
  }
}

/**
 * Staff: move a comment between the public thread and internal notes.
 * Internal → public is always allowed. Public → internal is refused once a
 * non-staff person has replied (it would take their words out of their own
 * sight) and for the official response; staff replies under it go internal
 * with it, so none is left dangling in the public view. The public count
 * follows.
 */
export async function setVisibility(
  tx: Prisma.TransactionClient,
  input: { orgId: string; feedbackItemId: string; commentId: string; visibility: CommentVisibility },
) {
  const c = await tx.comment.findUniqueOrThrow({
    where: { id: input.commentId },
    select: { visibility: true, kind: true, deletedAt: true, parentId: true, classification: true },
  });
  if (c.visibility === input.visibility) return;
  const live = (deleted: Date | null) => (deleted ? 0 : 1);

  if (input.visibility === "PUBLIC") {
    // Weighed against the ceiling now: a marking stays a marking.
    if (c.classification && markingForcesInternal(c.classification, await markingCeiling(input.orgId))) {
      throw new CommentChangeError("This note is marked above what the whole org may read, so it stays internal.");
    }
    if (c.parentId) {
      const parent = await tx.comment.findUniqueOrThrow({ where: { id: c.parentId }, select: { visibility: true } });
      if (parent.visibility !== "PUBLIC") {
        throw new CommentChangeError("Make the note it replies to public first.");
      }
    }
    await tx.comment.update({ where: { id: input.commentId }, data: { visibility: "PUBLIC" } });
    // Its edits were made while only the team could read it: the history
    // keeps who and when, not the earlier words.
    await tx.commentRevision.updateMany({
      where: { commentId: input.commentId, redactedAt: null },
      data: { redactedAt: new Date() },
    });
    const n = live(c.deletedAt);
    if (n) {
      await tx.feedbackItem.update({ where: { id: input.feedbackItemId }, data: { commentCount: { increment: n } } });
    }
    return;
  }

  if (c.kind === "OFFICIAL") throw new CommentChangeError("Unpin the official response before making it internal.");
  const replies = await tx.comment.findMany({
    where: { parentId: input.commentId, visibility: "PUBLIC" },
    select: { id: true, authorId: true, deletedAt: true },
  });
  const staff = await currentStaff(input.orgId, replies.filter((r) => !r.deletedAt).map((r) => r.authorId));
  if (replies.some((r) => !r.deletedAt && !staff.has(r.authorId))) {
    throw new CommentChangeError("Someone outside the feedback team has replied, so this stays public.");
  }
  await takeInternal(tx, { ...input, deletedAt: c.deletedAt, replies });
}

/**
 * Move a public comment and these public replies to internal notes: the
 * public count follows, backlinks go (internal notes never show as one), and
 * the notifications quoting them are taken back from everyone off the team.
 */
async function takeInternal(
  tx: Prisma.TransactionClient,
  input: {
    orgId: string;
    feedbackItemId: string;
    commentId: string;
    deletedAt: Date | null;
    replies: { id: string; deletedAt: Date | null }[];
  },
) {
  const ids = [input.commentId, ...input.replies.map((r) => r.id)];
  await tx.comment.updateMany({ where: { id: { in: ids } }, data: { visibility: "INTERNAL" } });
  const n = (input.deletedAt ? 0 : 1) + input.replies.filter((r) => !r.deletedAt).length;
  if (n) {
    await tx.feedbackItem.update({ where: { id: input.feedbackItemId }, data: { commentCount: { decrement: n } } });
  }
  await tx.reference.deleteMany({ where: { orgId: input.orgId, sourceType: "comment", sourceId: { in: ids } } });
  await withdrawNotifications(tx, input.orgId, ids);
}

/**
 * Staff: change or remove a comment's marking. Lowering it makes nothing
 * public by itself. Raising a public comment above what the org's ceiling
 * covers is a spill response: it is unpinned if it was the official answer,
 * and it goes internal with every reply under it (they answer what it said),
 * whoever wrote them.
 */
export async function setMarking(
  tx: Prisma.TransactionClient,
  input: { orgId: string; feedbackItemId: string; commentId: string; classification: ClassificationLevel | null },
): Promise<{ from: ClassificationLevel | null; ceiling: ClassificationLevel; tookInternal: boolean }> {
  const c = await tx.comment.findUniqueOrThrow({
    where: { id: input.commentId },
    select: { classification: true, visibility: true, kind: true, deletedAt: true },
  });
  const ceiling = await markingCeiling(input.orgId);
  if (input.classification) {
    if (!(await commentMarkingPolicy(input.orgId))) {
      throw new CommentChangeError("Classification markings are for government tenants.");
    }
    if (!markingAllowed(input.classification, ceiling)) {
      throw new CommentChangeError("That marking is above what this organization may hold.");
    }
  }
  await tx.comment.update({ where: { id: input.commentId }, data: { classification: input.classification } });

  const raised =
    !!input.classification && c.visibility === "PUBLIC" && markingForcesInternal(input.classification, ceiling);
  if (raised) await withdrawMarked(tx, { ...input, kind: c.kind, deletedAt: c.deletedAt });
  return { from: c.classification, ceiling, tookInternal: raised };
}

/**
 * A public comment is now marked above what the org's ceiling covers: it
 * stops being the official answer, and it goes internal with every public
 * reply under it. Returns how many replies went with it.
 */
async function withdrawMarked(
  tx: Prisma.TransactionClient,
  input: { orgId: string; feedbackItemId: string; commentId: string; kind: CommentKind; deletedAt: Date | null },
): Promise<number> {
  if (input.kind === "OFFICIAL") {
    await tx.comment.update({ where: { id: input.commentId }, data: { kind: "COMMENT" } });
    await tx.feedbackItem.updateMany({
      where: { id: input.feedbackItemId, officialCommentId: input.commentId },
      data: { officialCommentId: null },
    });
  }
  const replies = await tx.comment.findMany({
    where: { parentId: input.commentId, visibility: "PUBLIC" },
    select: { id: true, deletedAt: true },
  });
  await takeInternal(tx, { ...input, replies });
  return replies.length;
}

/**
 * After the org's ceiling or tenant class changes: every public feedback
 * comment now marked above what the ceiling covers is withdrawn the way a
 * raised marking is (unpinned, internal with its replies, notifications taken
 * back). The read-time filter already hides them; this takes back what was
 * sent and keeps the replies from surfacing on their own. One transaction per
 * comment, each re-checked inside it, and one audit entry per sweep.
 */
export async function sweepMarkedComments(input: {
  orgId: string;
  /** Null for the scheduled sweep: nobody did it. */
  actorId: string | null;
  reason: "ceiling_changed" | "tenant_class_changed" | "scheduled";
  ipAddress?: string | null;
}): Promise<{ comments: number; replies: number }> {
  const ceiling = await markingCeiling(input.orgId);
  const over = await prisma.comment.findMany({
    where: {
      orgId: input.orgId,
      subjectType: FEEDBACK_SUBJECT,
      visibility: "PUBLIC",
      AND: [{ classification: { not: null } }, { classification: { notIn: levelsReadableUnder(ceiling) } }],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  let comments = 0;
  let replies = 0;
  for (const { id } of over) {
    await prisma.$transaction(async (tx) => {
      const c = await tx.comment.findUnique({
        where: { id },
        select: { subjectId: true, visibility: true, kind: true, deletedAt: true, classification: true },
      });
      // A reply can be swept with its parent before its own turn comes.
      if (!c?.subjectId || c.visibility !== "PUBLIC" || !c.classification) return;
      if (!markingForcesInternal(c.classification, ceiling)) return;
      replies += await withdrawMarked(tx, {
        orgId: input.orgId,
        feedbackItemId: c.subjectId,
        commentId: id,
        kind: c.kind,
        deletedAt: c.deletedAt,
      });
      comments += 1;
    });
  }
  if (comments > 0) {
    await logAudit({
      orgId: input.orgId,
      userId: input.actorId ?? undefined,
      action: "feedback.comments.marking_sweep",
      entity: "organization",
      entityId: input.orgId,
      metadata: { reason: input.reason, ceiling, comments, replies },
      ipAddress: input.ipAddress ?? undefined,
    }).catch(() => {});
  }
  return { comments, replies };
}

/**
 * Take back the notifications that quote these comments from everyone not on
 * the team now: they carry a snippet of words those people may no longer
 * read. Matched on the comment anchor every comment notification links to.
 * A push or live event already delivered can't be recalled.
 */
async function withdrawNotifications(tx: Prisma.TransactionClient, orgId: string, commentIds: string[]) {
  const rows = await tx.notification.findMany({
    where: { orgId, OR: commentIds.map((id) => ({ url: { endsWith: `#c-${id}` } })) },
    select: { id: true, userId: true },
  });
  if (rows.length === 0) return;
  const staff = await currentStaff(orgId, rows.map((r) => r.userId));
  const drop = rows.filter((r) => !staff.has(r.userId)).map((r) => r.id);
  if (drop.length > 0) await tx.notification.deleteMany({ where: { id: { in: drop } } });
}

/** What a notification says about a marked comment: never its words. */
export const MARKED_COMMENT_NOTICE = "A marked comment was posted. Open it to read.";

/**
 * After the comment commits: tell the people it was addressed to. Mentions of
 * org members, the author of the comment replied to and, for a new comment,
 * the item's followers. Only people who can read the board now are told; the
 * writer never is; nobody is told twice. A marked comment's words stay out of
 * every notification (they reach push and lock screens). Best-effort.
 */
export async function notifyCommentAudience(input: {
  org: { id: string; slug: string };
  item: { id: string; title: string };
  comment: { id: string; content: string; authorId: string };
  /** Only these mention ids are new (an edit notifies only who it added). */
  mentionIds?: string[];
  repliedToUserId?: string | null;
  /** An internal note only ever notifies people currently on the team. */
  visibility?: CommentVisibility;
  /** The comment's marking, if any: the notification then carries no snippet. */
  classification?: ClassificationLevel | null;
  /** A NEW comment also tells everyone following the item (an edit doesn't). */
  notifySubscribers?: boolean;
}): Promise<void> {
  const { org, item, comment } = input;
  const url = `${feedbackItemUrl(org.slug, item.id)}#c-${comment.id}`;
  const internal = input.visibility === "INTERNAL";
  const audience = (ids: string[]) => (internal ? currentStaff(org.id, ids) : currentReaders(org.id, ids));

  let wanted = input.mentionIds ?? parseMentions(comment.content);
  let repliedTo = input.repliedToUserId ?? null;
  const allowed = await audience([...wanted, ...(repliedTo ? [repliedTo] : [])]);
  wanted = wanted.filter((id) => allowed.has(id));
  if (repliedTo && !allowed.has(repliedTo)) repliedTo = null;

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
  const message = input.classification
    ? MARKED_COMMENT_NOTICE
    : mentionsToPlainText(comment.content, labels).slice(0, 200);
  const notified = new Set<string>([comment.authorId]);

  for (const m of members) {
    if (notified.has(m.userId)) continue;
    notified.add(m.userId);
    await ensureSubscribed(prisma, { orgId: org.id, feedbackItemId: item.id, userId: m.userId, reason: "mention" }).catch(
      () => {},
    );
    await createNotification({
      orgId: org.id,
      userId: m.userId,
      type: "feedback.comment.mentioned",
      title: `Mentioned on "${item.title}"`,
      message,
      relatedId: item.id,
      relatedType: "feedback_item",
      url,
    }).catch(() => {});
  }

  if (repliedTo && !notified.has(repliedTo)) {
    notified.add(repliedTo);
    await createNotification({
      orgId: org.id,
      userId: repliedTo,
      type: "feedback.comment.replied",
      title: `New reply on "${item.title}"`,
      message,
      relatedId: item.id,
      relatedType: "feedback_item",
      url,
    }).catch(() => {});
  }

  if (!input.notifySubscribers) return;
  // Followers who haven't already heard about this comment and may read it now
  // (of an internal note, only the team).
  const pending = (await activeSubscriberIds(item.id)).filter((id) => !notified.has(id));
  if (pending.length === 0) return;
  const followers = await audience(pending);
  for (const userId of pending) {
    if (!followers.has(userId)) continue;
    await createNotification({
      orgId: org.id,
      userId,
      type: "feedback.comment.created",
      title: `New comment on "${item.title}"`,
      message,
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

/**
 * The scheduled backstop for sweepMarkedComments (jobs.ts). A ceiling change
 * sweeps in the same request, but a failure there only logs; this catches it,
 * so notifications and replies don't wait for the next ceiling write. Only orgs
 * that still have public marked feedback comments are looked at, and each
 * org's sweep is idempotent.
 */
export async function sweepAllMarkedComments(opts: { signal?: AbortSignal } = {}): Promise<{
  orgs: number;
  comments: number;
  replies: number;
}> {
  const orgs = await prisma.comment.findMany({
    where: { subjectType: FEEDBACK_SUBJECT, visibility: "PUBLIC", classification: { not: null } },
    distinct: ["orgId"],
    select: { orgId: true },
  });
  let comments = 0;
  let replies = 0;
  for (const { orgId } of orgs) {
    if (opts.signal?.aborted) break;
    const r = await sweepMarkedComments({ orgId, actorId: null, reason: "scheduled" });
    comments += r.comments;
    replies += r.replies;
  }
  return { orgs: orgs.length, comments, replies };
}
