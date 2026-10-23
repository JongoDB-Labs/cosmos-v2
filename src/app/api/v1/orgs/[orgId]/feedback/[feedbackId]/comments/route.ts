import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { success, created, handleApiError } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { publishToOrg } from "@/lib/realtime/broker";
import { syncReferences } from "@/lib/mentions/references";
import { canCommentOnFeedback } from "@/lib/feedback/access";
import {
  feedbackCommentDto,
  insertFeedbackComment,
  listFeedbackComments,
  notifyCommentAudience,
  resolveReplyParent,
} from "@/lib/feedback/comments.server";
import { json, loadFeedbackRoute, threadWriteBlock } from "@/lib/feedback/route-context.server";

type RouteParams = { params: Promise<{ orgId: string; feedbackId: string }> };

/** The discussion on one feedback item, as this viewer may see it. */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId } = await params;
    const route = await loadFeedbackRoute(orgId, feedbackId);
    if (route instanceof Response) return route;
    return success(await listFeedbackComments(orgId, feedbackId, route.viewer));
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  content: z.string().trim().min(1).max(10000),
  parentId: z.string().uuid().optional(),
});

/** Post a comment, or a reply (one level: a reply to a reply joins its thread). */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId } = await params;
    const route = await loadFeedbackRoute(orgId, feedbackId);
    if (route instanceof Response) return route;
    const { org, ctx, item, viewer } = route;

    if (!canCommentOnFeedback(ctx, item)) {
      return json(403, { error: "You can't comment on this request." });
    }
    const blocked = threadWriteBlock(route);
    if (blocked) return blocked;

    const limited = checkRateLimit(request, "feedback.comment", ctx.userId, {
      capacity: 20,
      refillPerSecond: 0.2,
    });
    if (limited) return limited;

    const data = createSchema.parse(await request.json());
    const parent = data.parentId
      ? await resolveReplyParent(orgId, feedbackId, data.parentId, viewer)
      : null;
    if (data.parentId && !parent) return json(400, { error: "That comment can't be replied to." });

    const comment = await prisma.$transaction((tx) =>
      insertFeedbackComment(tx, {
        orgId,
        feedbackItemId: feedbackId,
        authorId: ctx.userId,
        content: data.content,
        parentId: parent?.id ?? null,
      }),
    );

    try {
      publishToOrg(orgId, "feedback.comment.created", { feedbackId, commentId: comment.id });
    } catch {
      /* realtime is best-effort */
    }
    await notifyCommentAudience({
      org,
      item,
      comment: { id: comment.id, content: comment.content, authorId: ctx.userId },
      repliedToUserId: parent?.authorId ?? null,
    }).catch(() => {});
    void syncReferences({
      orgId,
      sourceType: "comment",
      sourceId: comment.id,
      content: comment.content,
      createdById: ctx.userId,
    }).catch(() => {});

    return created(await feedbackCommentDto(comment, viewer));
  } catch (e) {
    return handleApiError(e);
  }
}
