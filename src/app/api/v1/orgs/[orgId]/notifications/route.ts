import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { categoryTypeFilter } from "@/lib/notifications/categories";

type RouteParams = { params: Promise<{ orgId: string }> };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

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
    const category = sp.get("category");
    const cursor = sp.get("cursor");

    const parsedLimit = Number.parseInt(sp.get("limit") ?? "", 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

    const typeFilter = categoryTypeFilter(category);

    // Fetch one extra row to detect whether another page exists. Order by a
    // stable total order (createdAt, then id) so cursor pagination never skips
    // or repeats rows that share a createdAt.
    const rows = await prisma.notification.findMany({
      where: {
        orgId,
        userId: ctx.userId,
        ...(unreadOnly ? { read: false } : {}),
        ...(typeFilter ? { type: typeFilter } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    // Total unread across ALL categories drives the bell badge, so it must
    // ignore the active category filter. Only computed for the first page —
    // "load more" requests (cursor set) don't need it.
    const unreadCount = cursor
      ? null
      : await prisma.notification.count({
          where: { orgId, userId: ctx.userId, read: false },
        });

    return success({ items, nextCursor, unreadCount });
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

// Clear (delete) the caller's notifications. With no `category` it clears the
// entire feed; with a `category` it clears only that filtered slice so
// "Clear all" respects whatever the user is currently viewing.
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.NOTIFICATION_READ);

    const typeFilter = categoryTypeFilter(
      request.nextUrl.searchParams.get("category"),
    );

    const { count } = await prisma.notification.deleteMany({
      where: {
        orgId,
        userId: ctx.userId,
        ...(typeFilter ? { type: typeFilter } : {}),
      },
    });

    return success({ count });
  } catch (error) {
    return handleApiError(error);
  }
}
