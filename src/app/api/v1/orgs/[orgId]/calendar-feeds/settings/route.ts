import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { calendarFeedsEnabled } from "@/lib/calendar/feed-settings";
import { patchOrgSettings } from "@/lib/org/patch-settings.server";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * The org switch for calendar feeds (COSMOS-202), INTEGRATION_MANAGE only.
 * Turning it off makes every existing link return 404 at once; turning it
 * back on restores the links nobody revoked.
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true, settings: true } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.INTEGRATION_MANAGE);

    const { enabled } = z.object({ enabled: z.boolean() }).parse(await request.json());
    // Only `calendarFeeds.enabled` is written, against the row as it is now;
    // writing back the whole settings object read above would undo any other
    // setting changed since.
    const settingsBefore = await patchOrgSettings(org.id, { merge: { key: "calendarFeeds", fields: { enabled } } });
    if (!settingsBefore) return new Response("Not found", { status: 404 });
    const before = calendarFeedsEnabled(settingsBefore);
    if (before !== enabled) {
      await logAudit({
        orgId: org.id, userId: ctx.userId, action: enabled ? "calendar_feeds.enabled" : "calendar_feeds.disabled",
        entity: "organization", entityId: org.id, metadata: {}, ipAddress: getIpAddress(request),
      });
    }
    return success({ enabled });
  } catch (error) {
    return handleApiError(error);
  }
}
