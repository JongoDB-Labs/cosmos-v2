import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { success, handleApiError } from "@/lib/api-helpers";
import { loadFeedbackRoute } from "@/lib/feedback/route-context.server";
import { isFollowing, setFollowing } from "@/lib/feedback/subscriptions.server";

type RouteParams = { params: Promise<{ orgId: string; feedbackId: string }> };

/** Whether the caller follows this item (hears about new comments on it). */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId } = await params;
    const route = await loadFeedbackRoute(orgId, feedbackId);
    if (route instanceof Response) return route;
    return success({ following: await isFollowing(feedbackId, route.ctx.userId) });
  } catch (e) {
    return handleApiError(e);
  }
}

const putSchema = z.object({ following: z.boolean() });

/** Follow or stop following. Only ever the caller's own subscription. */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId } = await params;
    const route = await loadFeedbackRoute(orgId, feedbackId);
    if (route instanceof Response) return route;
    const { following } = putSchema.parse(await request.json());
    await setFollowing(prisma, {
      orgId,
      feedbackItemId: feedbackId,
      userId: route.ctx.userId,
      following,
    });
    return success({ following });
  } catch (e) {
    return handleApiError(e);
  }
}
