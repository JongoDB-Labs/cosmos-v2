import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; itemId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_READ);

    const item = await prisma.workItem.findFirst({ where: { id: itemId, orgId, projectId } });
    if (!item) return new Response("Not found", { status: 404 });

    const activities = await prisma.activity.findMany({
      where: { workItemId: itemId, orgId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    return success(activities);
  } catch (error) {
    return handleApiError(error);
  }
}
