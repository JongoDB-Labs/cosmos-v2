import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError } from "@/lib/api-helpers";
import { canSee, viewerScope } from "@/lib/query/saved-filters.server";

type RouteParams = { params: Promise<{ orgId: string; viewId: string }> };

const bodySchema = z.strictObject({ sortOrder: z.number().int().min(0).max(10_000).optional() });

/** The caller's star on a filter they can see (and its sidebar position). */
async function visible(orgId: string, viewId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return null;
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return "unauthorized" as const;
  // Starring is a write (PUT and DELETE both come through here): a key needs
  // ITEM_UPDATE (items:write), as the contract says; a session keeps ITEM_READ.
  requirePermission(ctx, ctx.isApiKey ? Permission.ITEM_UPDATE : Permission.ITEM_READ);
  const view = await prisma.savedView.findFirst({
    where: { id: viewId, orgId },
    select: { ownerId: true, visibility: true, projectId: true, teamId: true, editors: { select: { userId: true } } },
  });
  const s = await viewerScope(ctx);
  return view && canSee(s, view) ? ctx : null;
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, viewId } = await params;
    const ctx = await visible(orgId, viewId);
    if (ctx === "unauthorized") return new Response("Unauthorized", { status: 401 });
    if (!ctx) return new Response("Not found", { status: 404 });
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const sortOrder =
      body.sortOrder
      ?? ((await prisma.savedViewFavorite.aggregate({ where: { userId: ctx.userId }, _max: { sortOrder: true } }))._max.sortOrder ?? -1) + 1;
    const star = await prisma.savedViewFavorite.upsert({
      where: { savedViewId_userId: { savedViewId: viewId, userId: ctx.userId } },
      create: { savedViewId: viewId, userId: ctx.userId, sortOrder },
      update: body.sortOrder !== undefined ? { sortOrder } : {},
      select: { sortOrder: true },
    });
    return success({ favorite: true, sortOrder: star.sortOrder });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, viewId } = await params;
    const ctx = await visible(orgId, viewId);
    if (ctx === "unauthorized") return new Response("Unauthorized", { status: 401 });
    if (!ctx) return new Response("Not found", { status: 404 });
    await prisma.savedViewFavorite.deleteMany({ where: { savedViewId: viewId, userId: ctx.userId } });
    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
