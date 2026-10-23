import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { teamsAppPackage } from "@/lib/integrations/microsoft/teams-app/manifest";
import { teamsBotAppId } from "@/lib/integrations/microsoft/teams-app/identity.server";

type RouteParams = { params: Promise<{ orgId: string }> };

/** The Cosmos for Teams app package (zip), for an admin to upload to their Teams app catalog. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    if (!hasPermission(ctx.permissions, Permission.INTEGRATION_MANAGE)) return new Response("Forbidden", { status: 403 });
    const appId = await teamsBotAppId();
    if (!appId) return new Response(JSON.stringify({ error: "Configure the Microsoft sign-in app first." }), { status: 409, headers: { "Content-Type": "application/json" } });
    const zip = teamsAppPackage({ appId, origin: getPublicOrigin(request) });
    await logAudit({ orgId, userId: ctx.userId, action: "teams_app.package_downloaded", entity: "integration", entityId: orgId, ipAddress: getIpAddress(request) });
    return new Response(Buffer.from(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="cosmos-for-teams.zip"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
