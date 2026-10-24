import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { MS_CALENDAR } from "@/lib/integrations/microsoft/calendar-connect";
import { configuredPublicOrigin } from "@/lib/integrations/microsoft/hosts";
import { tabAppIdUri } from "@/lib/integrations/microsoft/teams-app/entra-auth.server";
import { MS_TEAMS_APP, teamsBotAppId } from "@/lib/integrations/microsoft/teams-app/identity.server";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * For admins: what setting up Cosmos for Teams needs (COSMOS-202 T1), in the
 * order it's needed. The bot's app id is the instance's Microsoft sign-in app,
 * which isn't secret (it's in every token Microsoft issues for it).
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    if (!hasPermission(ctx.permissions, Permission.INTEGRATION_MANAGE)) return new Response("Forbidden", { status: 403 });
    const [app, cal, appId] = await Promise.all([
      prisma.integration.findFirst({ where: { orgId, provider: MS_TEAMS_APP }, select: { status: true } }),
      prisma.integration.findFirst({ where: { orgId, provider: MS_CALENDAR }, select: { status: true, config: true } }),
      teamsBotAppId(),
    ]);
    const tenantId = (cal?.config as { tenantId?: unknown } | null)?.tenantId;
    // The tabs' sign-in trusts only the configured public URL, never the request's Host.
    const configured = configuredPublicOrigin();
    return success({
      installed: app?.status === "ACTIVE",
      calendarReady: cal?.status === "ACTIVE" && typeof tenantId === "string" && !!tenantId.trim(),
      appId,
      messagingEndpoint: `${configured ?? getPublicOrigin(request)}/api/teams/bot`,
      publicUrlConfigured: !!configured,
      appIdUri: appId && configured ? tabAppIdUri(configured, appId) : null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
