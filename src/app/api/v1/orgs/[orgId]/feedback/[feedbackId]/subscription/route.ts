import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { success, handleApiError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { loadFeedbackRoute } from "@/lib/feedback/route-context.server";
import { isFollowing, setFollowing } from "@/lib/feedback/subscriptions.server";

type RouteParams = { params: Promise<{ orgId: string; feedbackId: string }> };

/**
 * The board's own gate: ORG_READ, which no API-key scope carries, so these are
 * browser-only (the contract names no scope). loadFeedbackRoute already checks
 * it; it is stated here as well so the route's gate is visible to the scope
 * audits, which read a handler's own module.
 */
async function load(orgId: string, feedbackId: string) {
  const route = await loadFeedbackRoute(orgId, feedbackId);
  if (!(route instanceof Response)) requirePermission(route.ctx, Permission.ORG_READ);
  return route;
}

/** Whether the caller follows this item (hears about new comments on it). */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId } = await params;
    const route = await load(orgId, feedbackId);
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
    const route = await load(orgId, feedbackId);
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
