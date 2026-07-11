import { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { isHomeWidgetType } from "@/lib/home/widgets";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    // Personal widgets: scoped to the current user within this org.
    const widgets = await prisma.homeWidget.findMany({
      where: { orgId, ownerId: ctx.userId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });

    return success(widgets);
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  type: z.string().refine(isHomeWidgetType, "Unknown widget type"),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const data = createSchema.parse(await request.json());

    // Append to the end of the user's current widget list.
    const count = await prisma.homeWidget.count({
      where: { orgId, ownerId: ctx.userId },
    });

    try {
      const created = await prisma.homeWidget.create({
        data: {
          orgId,
          ownerId: ctx.userId,
          type: data.type,
          sortOrder: count,
        },
      });
      return success(created);
    } catch (e) {
      // @@unique([orgId, ownerId, type]) — this widget type is already pinned.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return new Response(
          JSON.stringify({ error: "That widget is already on your dashboard" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      throw e;
    }
  } catch (e) {
    return handleApiError(e);
  }
}

const reorderSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1),
});

/**
 * Persist a drag-to-arrange reorder of the caller's own dashboard widgets.
 * Renumbers `sortOrder` to match the incoming id order. Owner-scoped: only ids
 * that belong to THIS user in THIS org are touched, so a caller can't reshuffle
 * (or probe) someone else's dashboard by passing foreign widget ids.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const { orderedIds } = reorderSchema.parse(await request.json());

    const owned = await prisma.homeWidget.findMany({
      where: { orgId, ownerId: ctx.userId, id: { in: orderedIds } },
      select: { id: true },
    });
    const ownedSet = new Set(owned.map((w) => w.id));

    await prisma.$transaction(
      orderedIds
        .filter((id) => ownedSet.has(id))
        .map((id, index) =>
          prisma.homeWidget.update({
            where: { id },
            data: { sortOrder: index },
          }),
        ),
    );

    return success({ reordered: ownedSet.size });
  } catch (e) {
    return handleApiError(e);
  }
}
