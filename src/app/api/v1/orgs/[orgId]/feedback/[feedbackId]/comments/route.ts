import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { publishToOrg } from "@/lib/realtime/broker";
import { syncReferences } from "@/lib/mentions/references";
import { canCommentOnFeedback } from "@/lib/feedback/access";
import { markingAllowed, markingForcesInternal } from "@/lib/feedback/marking";
import {
  commentMarkingPolicy,
  feedbackCommentDto,
  insertFeedbackComment,
  listFeedbackComments,
  notifyCommentAudience,
  resolveReplyParent,
} from "@/lib/feedback/comments.server";
import { json, loadFeedbackRoute, threadWriteBlock } from "@/lib/feedback/route-context.server";

type RouteParams = { params: Promise<{ orgId: string; feedbackId: string }> };

const filterSchema = z.enum(["all", "public", "internal"]).catch("all");

/**
 * The discussion on one feedback item, as this viewer may see it. Staff can
 * narrow it with `?visibility=public|internal`; for anyone else it is public.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId } = await params;
    const route = await loadFeedbackRoute(orgId, feedbackId);
    if (route instanceof Response) return route;
    const filter = filterSchema.parse(request.nextUrl.searchParams.get("visibility") ?? "all");
    return success(await listFeedbackComments(orgId, feedbackId, route.viewer, filter));
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  content: z.string().trim().min(1).max(10000),
  parentId: z.string().uuid().optional(),
  /** Staff only: an internal note the rest of the org never sees. */
  visibility: z.enum(["PUBLIC", "INTERNAL"]).optional(),
  /** Staff only: the team's official response, pinned and always public. */
  kind: z.enum(["COMMENT", "OFFICIAL"]).optional(),
  /** Staff on a gov tenant only: a classification marking (FOUO is retired). */
  classification: z.enum(["PUBLIC", "UNCLASSIFIED", "CUI", "CONFIDENTIAL"]).optional(),
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

    const wantsInternal = data.visibility === "INTERNAL";
    const official = data.kind === "OFFICIAL";
    if ((wantsInternal || official) && !viewer.isStaff) {
      return json(403, { error: "Only the feedback team can post internal notes or official responses." });
    }
    if (official && (wantsInternal || parent)) {
      return json(400, { error: "An official response is a public, top-level comment." });
    }
    let markedInternal = false;
    let ceiling: string | null = null;
    if (data.classification) {
      if (!viewer.isStaff) return json(403, { error: "Only the feedback team can mark a comment." });
      const policy = await commentMarkingPolicy(orgId);
      if (!policy) return json(400, { error: "Classification markings are for government tenants." });
      ceiling = policy.orgCeiling;
      if (!markingAllowed(data.classification, policy.orgCeiling)) {
        return json(400, { error: "That marking is above what this organization may hold." });
      }
      markedInternal = markingForcesInternal(data.classification, policy.orgCeiling);
      if (markedInternal && official) {
        return json(400, { error: "A comment marked at this level stays internal, so it can't be the official response." });
      }
    }
    // A reply to an internal note is internal too: its context is invisible
    // to anyone outside the team. So is a comment marked above what the whole
    // org may read.
    const visibility =
      wantsInternal || markedInternal || parent?.visibility === "INTERNAL" ? "INTERNAL" : "PUBLIC";

    const comment = await prisma.$transaction((tx) =>
      insertFeedbackComment(tx, {
        orgId,
        feedbackItemId: feedbackId,
        authorId: ctx.userId,
        content: data.content,
        parentId: parent?.id ?? null,
        visibility,
        kind: official ? "OFFICIAL" : "COMMENT",
        classification: data.classification ?? null,
      }),
    );

    if (data.classification) {
      await logAudit({
        orgId,
        userId: ctx.userId,
        action: "feedback.comment.marked",
        entity: "comment",
        entityId: comment.id,
        metadata: { feedbackId, level: data.classification, ceiling, visibility },
        ipAddress: getIpAddress(request),
      }).catch(() => {});
    }
    // The org-wide channel reaches everyone, so an internal note is never
    // announced on it: even ids would tell the rest that one was written.
    if (visibility === "PUBLIC") {
      try {
        publishToOrg(orgId, "feedback.comment.created", { feedbackId, commentId: comment.id });
      } catch {
        /* realtime is best-effort */
      }
    }
    await notifyCommentAudience({
      org,
      item,
      comment: { id: comment.id, content: comment.content, authorId: ctx.userId },
      repliedToUserId: parent?.authorId ?? null,
      visibility,
      classification: data.classification ?? null,
      notifySubscribers: true,
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
