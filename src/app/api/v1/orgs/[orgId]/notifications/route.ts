import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.NOTIFICATION_READ);

    const sp = request.nextUrl.searchParams;
    const unreadOnly = sp.get("unreadOnly") === "true";
    // Optional, and the response is still a bare array either way — the bell
    // reads this endpoint and shows ten, so it asks for ten rather than
    // fetching an entire inbox to discard it. The paged, counted view the
    // inbox PAGE needs lives at ./inbox.
    const raw = Number(sp.get("limit"));
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 200) : undefined;

    const notifications = await prisma.notification.findMany({
      where: {
        orgId,
        userId: ctx.userId,
        ...(unreadOnly ? { read: false } : {}),
      },
      orderBy: { createdAt: "desc" },
      ...(limit ? { take: limit } : {}),
    });

    return success(notifications);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.NOTIFICATION_READ);

    await prisma.notification.updateMany({
      where: {
        orgId,
        userId: ctx.userId,
        read: false,
      },
      data: { read: true },
    });

    return success({ message: "All notifications marked as read" });
  } catch (error) {
    return handleApiError(error);
  }
}
