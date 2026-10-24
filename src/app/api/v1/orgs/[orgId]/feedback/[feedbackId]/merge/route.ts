import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { success, handleApiError } from "@/lib/api-helpers";
import { requireAccess } from "@/lib/abac/require-access";
import { logAudit } from "@/lib/audit";
import { publishToOrg } from "@/lib/realtime/broker";
import { createNotification } from "@/lib/notifications/create";
import { feedbackItemUrl } from "@/lib/feedback/urls";
import { json, loadFeedbackRoute } from "@/lib/feedback/route-context.server";
import { isTxConflict, mergeFeedback, MergeError, undoMerge } from "@/lib/feedback/merge.server";

type RouteParams = { params: Promise<{ orgId: string; feedbackId: string }> };

const mergeSchema = z.object({ survivorId: z.string().uuid() });

const refused = (e: MergeError) => json(e.code === "not-found" ? 404 : 409, { error: e.message, code: e.code });
const busy = () =>
  json(409, { error: "Someone else is changing these requests right now. Try again.", code: "busy" });

/**
 * Merge this request into another (staff). Same authority as triaging its
 * status: a merge is a status change with its votes and followers attached.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId } = await params;
    const route = await loadFeedbackRoute(orgId, feedbackId);
    if (route instanceof Response) return route;
    await requireAccess(route.ctx, "ORG_UPDATE", { createdById: route.item.authorId });
    const { survivorId } = mergeSchema.parse(await request.json());
    // A merge changes the survivor too (votes and followers land on it), so
    // ABAC rules on its author apply as well. Another org's id is simply not found.
    const survivorRow = await prisma.feedbackItem.findFirst({
      where: { id: survivorId, orgId },
      select: { authorId: true },
    });
    if (!survivorRow) return json(404, { error: "The request to merge into was not found.", code: "not-found" });
    await requireAccess(route.ctx, "ORG_UPDATE", { createdById: survivorRow.authorId });

    let result: Awaited<ReturnType<typeof mergeFeedback>>;
    try {
      result = await prisma.$transaction((tx) =>
        mergeFeedback(tx, {
          orgId,
          duplicateId: feedbackId,
          survivorId,
          source: "manual",
          mergedById: route.ctx.userId,
          // The request actually merged into may be further along the chain.
          authorizeSurvivor: (s) => requireAccess(route.ctx, "ORG_UPDATE", { createdById: s.authorId }),
        }),
      );
    } catch (e) {
      if (e instanceof MergeError) return refused(e);
      if (isTxConflict(e)) return busy();
      throw e;
    }

    await logAudit({
      orgId,
      userId: route.ctx.userId,
      action: "feedback.merged",
      entity: "feedback_item",
      entityId: feedbackId,
      metadata: { survivorId: result.survivor.id, mergeId: result.mergeId },
    }).catch(() => {});
    try {
      publishToOrg(orgId, "feedback.merged", { feedbackId, survivorId: result.survivor.id });
    } catch {
      /* realtime is best-effort */
    }
    if (route.item.authorId !== route.ctx.userId) {
      await createNotification({
        orgId,
        userId: route.item.authorId,
        type: "feedback.merged",
        title: `Your request was merged into "${result.survivor.title}"`,
        message: `"${route.item.title}" is the same request as "${result.survivor.title}". Your vote and follow carried over; the discussion continues there.`,
        relatedId: result.survivor.id,
        relatedType: "feedback_item",
        url: feedbackItemUrl(route.org.slug, result.survivor.id),
      }).catch(() => {});
    }
    return success({ merged: true, survivorId: result.survivor.id });
  } catch (e) {
    return handleApiError(e);
  }
}

/** Undo this request's merge (staff): its status, votes and followers come back. */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId } = await params;
    const route = await loadFeedbackRoute(orgId, feedbackId);
    if (route instanceof Response) return route;
    await requireAccess(route.ctx, "ORG_UPDATE", { createdById: route.item.authorId });

    let result: Awaited<ReturnType<typeof undoMerge>>;
    try {
      result = await prisma.$transaction((tx) => undoMerge(tx, { orgId, duplicateId: feedbackId, undoneById: route.ctx.userId }));
    } catch (e) {
      if (e instanceof MergeError) return refused(e);
      if (isTxConflict(e)) return busy();
      throw e;
    }

    await logAudit({
      orgId,
      userId: route.ctx.userId,
      action: "feedback.merge_undone",
      entity: "feedback_item",
      entityId: feedbackId,
      metadata: { survivorId: result.survivorId, restoredStatus: result.restoredStatus },
    }).catch(() => {});
    try {
      publishToOrg(orgId, "feedback.unmerged", { feedbackId, survivorId: result.survivorId });
    } catch {
      /* realtime is best-effort */
    }
    return success({ merged: false, status: result.restoredStatus });
  } catch (e) {
    return handleApiError(e);
  }
}
