import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; themeId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, themeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.THEME_MANAGE);

    const theme = await prisma.theme.findFirst({
      where: { id: themeId, OR: [{ orgId: null }, { orgId }] },
    });
    if (!theme) return new Response("Not found", { status: 404 });

    await prisma.$transaction([
      prisma.theme.updateMany({
        where: { orgId, isActive: true },
        data: { isActive: false },
      }),
      prisma.theme.update({
        where: { id: themeId },
        data: { isActive: true },
      }),
    ]);

    const activated = await prisma.theme.findUnique({ where: { id: themeId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "theme.activated",
      entity: "theme",
      entityId: themeId,
      metadata: { name: theme.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(activated);
  } catch (error) {
    return handleApiError(error);
  }
}
