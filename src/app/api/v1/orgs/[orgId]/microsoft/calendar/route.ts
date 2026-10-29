import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { getProviderConfig } from "@/lib/auth/provider-config";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { MS_CALENDAR, MS_CALENDAR_CALLBACK_PATH, calendarAdminConsentUrl } from "@/lib/integrations/microsoft/calendar-connect";
import { liveInvites, releaseInvitesOnDisconnect, removeCosmosCalendar } from "@/lib/integrations/microsoft/calendar-sync.server";
import { calendarConnection, calendarSharingState, disconnectCalendar, orgCalendarConfig } from "@/lib/integrations/microsoft/calendar-token.server";

type RouteParams = { params: Promise<{ orgId: string }> };

async function resolve(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true } });
  if (!org) return null;
  const ctx = await getAuthContext(org.slug);
  return ctx ? { org, ctx } : null;
}

/**
 * The signed-in person's Outlook Calendar connection (COSMOS-202 B1), the
 * sharing level their published events carry with the org default behind it,
 * and, for admins, what the Entra app needs: the redirect URI to register and
 * the one-time admin-consent link. Never a token.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const r = await resolve((await params).orgId);
    if (!r) return new Response("Unauthorized", { status: 401 });
    const [cfg, conn] = await Promise.all([orgCalendarConfig(r.org.id), calendarConnection(r.org.id, r.ctx.userId)]);
    const sharing = await calendarSharingState(r.org.id, conn?.meta);
    const canManage = hasPermission(r.ctx.permissions, Permission.INTEGRATION_MANAGE);
    const redirectUri = `${getPublicOrigin(request)}${MS_CALENDAR_CALLBACK_PATH}`;
    let admin: { redirectUri: string; adminConsentUrl: string | null; appConfigured: boolean } | null = null;
    if (canManage) {
      const integration = await prisma.integration.findFirst({
        where: { orgId: r.org.id, provider: MS_CALENDAR },
        select: { config: true },
      });
      const tenantId = (integration?.config as { tenantId?: string } | null)?.tenantId ?? null;
      const app = await getProviderConfig("microsoft");
      admin = {
        redirectUri,
        appConfigured: Boolean(app),
        adminConsentUrl: app && tenantId ? calendarAdminConsentUrl({ clientId: app.clientId, tenantId, redirectUri, orgSlug: r.org.slug }) : null,
      };
    }
    return success({
      enabled: Boolean(cfg),
      canManage,
      admin,
      sharing,
      connection: conn
        ? { account: conn.meta.upn, status: conn.meta.status, connectedAt: conn.meta.connectedAt, lastSyncAt: conn.meta.lastSyncAt ?? null }
        : null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Disconnect: the Outlook "Cosmos" calendar is removed if Microsoft allows, then
 * our sealed token and links are deleted. Someone who sends Outlook invitations
 * for upcoming meetings must say what happens to them (?invites=keep|cancel);
 * without it the answer is 409 with how many there are.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const r = await resolve((await params).orgId);
    if (!r) return new Response("Unauthorized", { status: 401 });
    const choice = request.nextUrl.searchParams.get("invites");
    const live = (await liveInvites(r.org.id, r.ctx.userId)).length;
    if (live > 0) {
      if (choice !== "keep" && choice !== "cancel") {
        return new Response(JSON.stringify({ error: "Choose what happens to your Outlook invitations.", liveInvites: live }), {
          status: 409, headers: { "Content-Type": "application/json" },
        });
      }
      await releaseInvitesOnDisconnect(r.org.id, r.ctx.userId, choice);
    }
    const calendarRemoved = await removeCosmosCalendar(r.org.id, r.ctx.userId);
    const had = await disconnectCalendar(r.org.id, r.ctx.userId);
    if (had) {
      await logAudit({
        orgId: r.org.id, userId: r.ctx.userId, action: "microsoft_calendar.disconnected",
        entity: "user", entityId: r.ctx.userId, metadata: { calendarRemoved: String(calendarRemoved) }, ipAddress: getIpAddress(request),
      });
    }
    return success({ disconnected: had });
  } catch (error) {
    return handleApiError(error);
  }
}
