import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { publishToOrg } from "@/lib/realtime/broker";
import { syncReferences } from "@/lib/mentions/references";
import { parseMentions } from "@/lib/chat/mentions";
import { logAudit } from "@/lib/audit";
import {
  FEEDBACK_COMMENT_SELECT,
  feedbackCommentDto,
  getFeedbackComment,
  notifyCommentAudience,
} from "@/lib/feedback/comments.server";
import { json, loadFeedbackRoute, threadWriteBlock } from "@/lib/feedback/route-context.server";

type RouteParams = { params: Promise<{ orgId: string; feedbackId: string; commentId: string }> };

const editSchema = z.object({ content: z.string().trim().min(1).max(10000) });

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
    if (existing.authorId !== ctx.userId || existing.kind !== "COMMENT") {
      return json(403, { error: "Only the author can edit this comment." });
    }
    const blocked = threadWriteBlock(route);
    if (blocked) return blocked;

    const { content } = editSchema.parse(await request.json());
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
      }).catch(() => {});
    }
    try {
      publishToOrg(orgId, "feedback.comment.updated", { feedbackId, commentId });
    } catch {
      /* realtime is best-effort */
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
    try {
      publishToOrg(orgId, "feedback.comment.deleted", { feedbackId, commentId });
    } catch {
      /* realtime is best-effort */
    }
    return success({ id: commentId });
  } catch (e) {
    return handleApiError(e);
  }
}

function reload(commentId: string) {
  return prisma.comment.findUniqueOrThrow({ where: { id: commentId }, select: FEEDBACK_COMMENT_SELECT });
}
