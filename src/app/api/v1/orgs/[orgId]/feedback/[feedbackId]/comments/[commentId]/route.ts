import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { publishToOrg } from "@/lib/realtime/broker";
import { syncReferences } from "@/lib/mentions/references";
import { parseMentions } from "@/lib/chat/mentions";
import { logAudit } from "@/lib/audit";
import {
  CommentChangeError,
  FEEDBACK_COMMENT_SELECT,
  canEditKind,
  feedbackCommentDto,
  getFeedbackComment,
  notifyCommentAudience,
  setMarking,
  setOfficial,
  setVisibility,
} from "@/lib/feedback/comments.server";
import { json, loadFeedbackRoute, threadWriteBlock } from "@/lib/feedback/route-context.server";

type RouteParams = { params: Promise<{ orgId: string; feedbackId: string; commentId: string }> };

const editSchema = z.object({ content: z.string().trim().min(1).max(10000) });
/** Staff moderation, one change per request. */
const staffSchema = z.union([
  z.object({ visibility: z.enum(["PUBLIC", "INTERNAL"]) }).strict(),
  z.object({ official: z.boolean() }).strict(),
  z.object({ classification: z.enum(["PUBLIC", "UNCLASSIFIED", "CUI", "CONFIDENTIAL"]).nullable() }).strict(),
]);

/**
 * Edit your own comment. The words as they were go into the comment's history
 * (shown behind its "edited" label), and only people newly @mentioned by the
 * edit are notified. Staff do not rewrite other people's words.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId, commentId } = await params;
    const route = await loadFeedbackRoute(orgId, feedbackId);
    if (route instanceof Response) return route;
    const { org, ctx, item, viewer } = route;

    const existing = await getFeedbackComment(orgId, feedbackId, commentId, viewer);
    if (!existing || existing.deletedAt) return new Response("Not found", { status: 404 });
    const blocked = threadWriteBlock(route);
    if (blocked) return blocked;

    const body: unknown = await request.json();
    const staffChange = staffSchema.safeParse(body);
    if (staffChange.success) {
      if (!viewer.isStaff) return json(403, { error: "Only the feedback team can do that." });
      const change = staffChange.data;
      type MarkingChange = Awaited<ReturnType<typeof setMarking>> & { to: string | null };
      let marking: MarkingChange | null = null;
      try {
        await prisma.$transaction(async (tx) => {
          if ("visibility" in change) {
            await setVisibility(tx, { orgId, feedbackItemId: feedbackId, commentId, visibility: change.visibility });
          } else if ("official" in change) {
            await setOfficial(tx, { orgId, feedbackItemId: feedbackId, commentId, official: change.official });
          } else {
            const result = await setMarking(tx, {
              orgId,
              feedbackItemId: feedbackId,
              commentId,
              classification: change.classification,
            });
            marking = { ...result, to: change.classification };
          }
        });
      } catch (e) {
        if (e instanceof CommentChangeError) return json(409, { error: e.message });
        throw e;
      }
      // Assigned inside the transaction callback, which TypeScript can't follow.
      const m = marking as MarkingChange | null;
      await logAudit({
        orgId,
        userId: ctx.userId,
        action:
          "visibility" in change
            ? "feedback.comment.visibility_changed"
            : "official" in change
              ? "feedback.comment.official_changed"
              : "feedback.comment.marking_changed",
        entity: "comment",
        entityId: commentId,
        metadata: m
          ? { feedbackId, from: m.from, to: m.to, ceiling: m.ceiling, tookInternal: m.tookInternal }
          : { feedbackId, ...change },
        ipAddress: getIpAddress(request),
      }).catch(() => {});
      // Pinning and converting touch a comment that is or was public, so the
      // whole org's view has to follow; a marking change only when it was.
      if (!("classification" in change) || existing.visibility === "PUBLIC") {
        try {
          publishToOrg(orgId, "feedback.comment.updated", { feedbackId, commentId });
        } catch {
          /* realtime is best-effort */
        }
      }
      const after = await reload(commentId);
      if ("visibility" in staffChange.data && staffChange.data.visibility === "PUBLIC") {
        // Its mentions become backlinks now that everyone can read it.
        void syncReferences({
          orgId,
          sourceType: "comment",
          sourceId: commentId,
          content: after.content,
          createdById: after.authorId,
        }).catch(() => {});
      }
      return success(await feedbackCommentDto(after, viewer));
    }

    if (existing.authorId !== ctx.userId || (existing.kind !== "COMMENT" && existing.kind !== "OFFICIAL")) {
      return json(403, { error: "Only the author can edit this comment." });
    }
    if (!canEditKind(existing.kind, viewer)) {
      return json(403, { error: "This is pinned as the team's official response. It can be edited once it's unpinned." });
    }
    const { content } = editSchema.parse(body);
    if (content === existing.content) {
      return success(await feedbackCommentDto({ ...(await reload(commentId)) }, viewer));
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.commentRevision.create({
        data: { commentId, content: existing.content, editedById: ctx.userId },
      });
      return tx.comment.update({
        where: { id: commentId },
        data: { content, editedAt: new Date() },
        select: FEEDBACK_COMMENT_SELECT,
      });
    });

    const before = new Set(parseMentions(existing.content));
    const added = parseMentions(content).filter((id) => !before.has(id));
    if (added.length > 0) {
      await notifyCommentAudience({
        org,
        item,
        comment: { id: commentId, content, authorId: ctx.userId },
        mentionIds: added,
        visibility: existing.visibility,
        classification: existing.classification,
      }).catch(() => {});
    }
    if (existing.visibility === "PUBLIC") {
      try {
        publishToOrg(orgId, "feedback.comment.updated", { feedbackId, commentId });
      } catch {
        /* realtime is best-effort */
      }
    }
    void syncReferences({
      orgId,
      sourceType: "comment",
      sourceId: commentId,
      content,
      createdById: ctx.userId,
    }).catch(() => {});

    return success(await feedbackCommentDto(updated, viewer));
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * Delete a comment: the author's own, or any as staff. Soft, so a comment with
 * replies leaves a tombstone and the conversation still reads; its words are
 * never served again.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId, commentId } = await params;
    const route = await loadFeedbackRoute(orgId, feedbackId);
    if (route instanceof Response) return route;
    const { ctx, viewer } = route;

    const existing = await getFeedbackComment(orgId, feedbackId, commentId, viewer);
    if (!existing || existing.deletedAt) return new Response("Not found", { status: 404 });
    const mine = existing.authorId === ctx.userId;
    if (!mine && !viewer.isStaff) {
      return json(403, { error: "Only the author or the feedback team can delete this comment." });
    }

    await prisma.$transaction(async (tx) => {
      await tx.comment.update({
        where: { id: commentId },
        data: { deletedAt: new Date(), deletedById: ctx.userId },
      });
      if (existing.visibility === "PUBLIC") {
        await tx.feedbackItem.update({
          where: { id: feedbackId },
          data: { commentCount: { decrement: 1 } },
        });
      }
      // A deleted official response is no longer the item's answer.
      await tx.feedbackItem.updateMany({
        where: { id: feedbackId, officialCommentId: commentId },
        data: { officialCommentId: null },
      });
      await tx.reference.deleteMany({ where: { orgId, sourceType: "comment", sourceId: commentId } });
    });

    if (!mine) {
      await logAudit({
        orgId,
        userId: ctx.userId,
        action: "feedback.comment.deleted",
        entity: "comment",
        entityId: commentId,
        metadata: { feedbackId, authorId: existing.authorId },
        ipAddress: getIpAddress(request),
      }).catch(() => {});
    }
    if (existing.visibility === "PUBLIC") {
      try {
        publishToOrg(orgId, "feedback.comment.deleted", { feedbackId, commentId });
      } catch {
        /* realtime is best-effort */
      }
    }
    return success({ id: commentId });
  } catch (e) {
    return handleApiError(e);
  }
}

function reload(commentId: string) {
  return prisma.comment.findUniqueOrThrow({ where: { id: commentId }, select: FEEDBACK_COMMENT_SELECT });
}
