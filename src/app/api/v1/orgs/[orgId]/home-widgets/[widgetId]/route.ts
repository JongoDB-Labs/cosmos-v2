import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string; widgetId: string }> };

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, widgetId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    // Malformed (non-UUID) id → clean 404 rather than a Prisma validation 500.
    if (!/^[0-9a-f-]{36}$/i.test(widgetId)) {
      return new Response("Not found", { status: 404 });
    }

    // Owner-only: a user can only remove their own home widgets.
    const existing = await prisma.homeWidget.findFirst({
      where: { id: widgetId, orgId, ownerId: ctx.userId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.homeWidget.delete({ where: { id: widgetId } });

    return success({ id: widgetId });
  } catch (e) {
    return handleApiError(e);
  }
}
