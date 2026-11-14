import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext, getCurrentUser } from "@/lib/auth/session";
import { refuseApiKey } from "@/lib/auth/key-gate";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { calendarFeedsEnabled, feedOptionsSchema, readFeedOptions } from "@/lib/calendar/feed-settings";
import { feedPath, newFeedToken } from "@/lib/calendar/feed-token";
import { feedMeetsSso } from "@/lib/calendar/feed.server";

type RouteParams = { params: Promise<{ orgId: string }> };

/** A person can hold a few links (say, one per calendar app), not an unbounded pile. */
const MAX_ACTIVE_FEEDS = 5;


async function resolve(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true, settings: true } });
  if (!org) return null;
  const ctx = await getAuthContext(org.slug);
  return ctx ? { org, ctx } : null;
}

/**
 * The signed-in person's calendar feed links in this org (COSMOS-202), without
 * their tokens: a token is shown once, at creation, and never again.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const r = await resolve((await params).orgId);
    if (!r) return new Response("Unauthorized", { status: 401 });
    // Links are made, changed and listed in the browser (POST and PATCH say why).
    refuseApiKey(r.ctx);
    const feeds = await prisma.calendarFeed.findMany({
      where: { orgId: r.org.id, userId: r.ctx.userId, revokedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, options: true, createdAt: true, lastFetchedAt: true },
    });
    return success({
      enabled: calendarFeedsEnabled(r.org.settings),
      canManage: hasPermission(r.ctx.permissions, Permission.INTEGRATION_MANAGE),
      feeds: feeds.map((f) => ({ ...f, options: readFeedOptions(f.options) })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/** Create a link. The response carries the URL, the only time it is ever shown. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const r = await resolve((await params).orgId);
    if (!r) return new Response("Unauthorized", { status: 401 });
    // Browser only. The link is an unauthenticated feed of its owner's items,
    // meetings and sprints: it ignores a key's projectScope and outlives the
    // key's revocation, so a key minting one would escape both.
    refuseApiKey(r.ctx, "Calendar feed links can only be created from the browser.");
    if (!calendarFeedsEnabled(r.org.settings)) {
      return NextResponse.json({ error: "Calendar feeds are turned off for this organization." }, { status: 403 });
    }
    // The session's IdP is recorded on the link: where the org requires single
    // sign-on, that is what lets it be served (feedMeetsSso), as for a member's
    // API key. Asked here too, so a link is never made that would then be refused.
    const idpConnId = (await getCurrentUser())?.idpConnId ?? null;
    if (!(await feedMeetsSso(r.org.id, idpConnId))) {
      return NextResponse.json(
        { error: "This organization requires single sign-on. Sign in through it to create a calendar link." },
        { status: 403 },
      );
    }
    const options = feedOptionsSchema.parse((await request.json().catch(() => ({})))?.options ?? readFeedOptions({}));
    const active = await prisma.calendarFeed.count({ where: { orgId: r.org.id, userId: r.ctx.userId, revokedAt: null } });
    if (active >= MAX_ACTIVE_FEEDS) {
      return NextResponse.json({ error: `You can have up to ${MAX_ACTIVE_FEEDS} links. Revoke one first.` }, { status: 400 });
    }
    const { token, tokenHash } = newFeedToken();
    const feed = await prisma.calendarFeed.create({
      data: { orgId: r.org.id, userId: r.ctx.userId, tokenHash, options, idpConnId },
      select: { id: true, options: true, createdAt: true, lastFetchedAt: true },
    });
    // Never the token or the URL: an audit row is read by more people than the link's owner.
    await logAudit({
      orgId: r.org.id, userId: r.ctx.userId, action: "calendar_feed.created", entity: "calendar_feed",
      entityId: feed.id, metadata: {}, ipAddress: getIpAddress(request),
    });
    return created({ ...feed, url: `${getPublicOrigin(request)}${feedPath(token)}` });
  } catch (error) {
    return handleApiError(error);
  }
}
