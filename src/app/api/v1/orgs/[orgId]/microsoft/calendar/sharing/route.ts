import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { SHARING_LEVELS, withOrgSharingLevel } from "@/lib/integrations/microsoft/calendar-sharing";
import { calendarConnection, calendarSharingState, patchCalendarMeta } from "@/lib/integrations/microsoft/calendar-token.server";
import { syncUserSoon } from "@/lib/integrations/microsoft/calendar-sync.server";

type RouteParams = { params: Promise<{ orgId: string }> };

const body = z.object({
  level: z.enum([...SHARING_LEVELS, "default"]).optional(),
  orgDefault: z.enum(SHARING_LEVELS).optional(),
});

/**
 * COSMOS-202: how much of someone's Cosmos events their Outlook carries —
 * full details, or free/busy only, the way a calendar app's sharing levels
 * work. `level` is the caller's own ("default" follows the org); `orgDefault`
 * is the org-wide default and needs INTEGRATION_MANAGE. Classified meetings
 * are busy-only whatever is set here.
 *
 * A level the caller changes takes effect at once (their copies are rewritten
 * after the response); a new org default reaches everyone else at their next
 * scheduled sync.
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true, settings: true } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // What a person's own mailbox shows is theirs to set, from the browser.
    if (ctx.isApiKey) return new Response("Forbidden", { status: 403 });
    const { level, orgDefault } = body.parse(await request.json());

    if (orgDefault) {
      requirePermission(ctx, Permission.INTEGRATION_MANAGE);
      await prisma.organization.update({
        where: { id: org.id },
        data: { settings: withOrgSharingLevel(org.settings, orgDefault) as Prisma.InputJsonValue },
      });
      await logAudit({
        orgId: org.id, userId: ctx.userId, action: "microsoft_calendar.sharing_default_set",
        entity: "organization", entityId: org.id, metadata: { level: orgDefault }, ipAddress: getIpAddress(request),
      });
    }

    let conn = await calendarConnection(org.id, ctx.userId);
    if (level) {
      if (!conn) return Response.json({ error: "Connect your Outlook Calendar first." }, { status: 409 });
      // "default" is the absence of a choice, so it is removed, not stored.
      if (level === "default") await patchCalendarMeta(conn.id, {}, ["sharingLevel"]);
      else await patchCalendarMeta(conn.id, { sharingLevel: level });
      await logAudit({
        orgId: org.id, userId: ctx.userId, action: "microsoft_calendar.sharing_level_set",
        entity: "user", entityId: ctx.userId, metadata: { level }, ipAddress: getIpAddress(request),
      });
      conn = await calendarConnection(org.id, ctx.userId);
    }
    // Their own copies are rewritten now (a new org default reaches everyone
    // else at the next scheduled pull, which reconciles what it changed).
    if (conn && (level || orgDefault)) syncUserSoon(org.id, ctx.userId);
    return success(await calendarSharingState(org.id, conn?.meta));
  } catch (error) {
    return handleApiError(error);
  }
}
