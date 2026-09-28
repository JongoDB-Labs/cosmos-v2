import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string }> };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * The inbox: everything waiting on THIS person, paged, with a count per kind.
 *
 * Separate from `/notifications`, which the bell reads and which answers with a
 * bare array. The bell wants the newest few; a page wants to page, and wants to
 * know the shape of what is waiting before showing any of it — 431 "past due"
 * notices and 4 of something else is a different morning from the reverse, and
 * a list capped at ten cannot tell them apart.
 *
 * Always this actor's own. A notification is addressed to a person, so there is
 * no wider scope to ask for and no filter that could widen it.
 */
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
    const type = sp.get("type");
    const cursor = sp.get("cursor");
    const limit = Math.min(
      Math.max(Number(sp.get("limit")) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );

    const mine = { orgId, userId: ctx.userId };

    const [rows, byType, unreadTotal, total] = await Promise.all([
      prisma.notification.findMany({
        where: {
          ...mine,
          ...(unreadOnly ? { read: false } : {}),
          ...(type ? { type } : {}),
          ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: limit + 1,
      }),
      // Counts describe the WHOLE inbox, not the page, and deliberately ignore
      // the type filter — otherwise picking a kind would hide the others and
      // there would be no way back to them.
      prisma.notification.groupBy({
        by: ["type"],
        where: { ...mine, ...(unreadOnly ? { read: false } : {}) },
        _count: { _all: true },
      }),
      prisma.notification.count({ where: { ...mine, read: false } }),
      prisma.notification.count({ where: mine }),
    ]);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return success({
      data: page.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        url: n.url,
        refType: n.refType,
        refId: n.refId,
        read: n.read,
        createdAt: n.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
      counts: {
        total,
        unread: unreadTotal,
        byType: byType
          .map((g) => ({ type: g.type, count: g._count._all }))
          .sort((a, b) => b.count - a.count),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Mark everything read, or everything of one kind.
 *
 * Scoped by the same `mine` clause as the read path: a bulk write that could
 * reach another person's inbox is the one mistake this endpoint must not make.
 * Marking a kind read rather than the whole inbox matters when 431 of the 524
 * are the same notice — clearing those should not also clear the four that are
 * different.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.NOTIFICATION_READ);

    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      type?: string;
    };
    if (body.action !== "read-all") {
      return new Response("Unknown action", { status: 400 });
    }

    const result = await prisma.notification.updateMany({
      where: {
        orgId,
        userId: ctx.userId,
        read: false,
        ...(body.type ? { type: body.type } : {}),
      },
      data: { read: true },
    });
    return success({ marked: result.count });
  } catch (error) {
    return handleApiError(error);
  }
}
