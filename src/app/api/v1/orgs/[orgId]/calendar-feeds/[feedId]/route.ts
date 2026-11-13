import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { refuseApiKey } from "@/lib/auth/key-gate";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { feedOptionsSchema, readFeedOptions } from "@/lib/calendar/feed-settings";

type RouteParams = { params: Promise<{ orgId: string; feedId: string }> };

const patchSchema = z.object({ options: feedOptionsSchema });

/**
 * Only the link's owner can change or revoke it; anyone else gets a 404.
 * `browserOnly` refuses an API key before the link is looked up.
 */
async function ownFeed(orgId: string, feedId: string, browserOnly: { refuseKeys: string } | null) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true } });
  if (!org) return null;
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return null;
  if (browserOnly) refuseApiKey(ctx, browserOnly.refuseKeys);
  const feed = await prisma.calendarFeed.findFirst({
    where: { id: feedId, orgId: org.id, userId: ctx.userId, revokedAt: null },
    select: { id: true },
  });
  return feed ? { ctx, feed, orgId: org.id } : null;
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedId } = await params;
    // Browser only, like creating one: new options widen what an existing
    // unauthenticated link exposes. Revoking (DELETE) stays open to a key.
    const r = await ownFeed(orgId, feedId, { refuseKeys: "Calendar feed links can only be changed from the browser." });
    if (!r) return new Response("Not found", { status: 404 });
    const { options } = patchSchema.parse(await request.json());
    const feed = await prisma.calendarFeed.update({
      where: { id: r.feed.id },
      data: { options },
      select: { id: true, options: true, createdAt: true, lastFetchedAt: true },
    });
    return success({ ...feed, options: readFeedOptions(feed.options) });
  } catch (error) {
    return handleApiError(error);
  }
}

/** Revoke: the link stops working on the calendar's next refresh. */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedId } = await params;
    // Open to any key: revoking a link only ever narrows what it exposes.
    const r = await ownFeed(orgId, feedId, null);
    if (!r) return new Response("Not found", { status: 404 });
    await prisma.calendarFeed.update({ where: { id: r.feed.id }, data: { revokedAt: new Date() } });
    await logAudit({
      orgId: r.orgId, userId: r.ctx.userId, action: "calendar_feed.revoked", entity: "calendar_feed",
      entityId: r.feed.id, metadata: {}, ipAddress: getIpAddress(request),
    });
    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
