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
