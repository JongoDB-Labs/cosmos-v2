import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError } from "@/lib/api-helpers";
import type { Prisma } from "@prisma/client";

type RouteParams = { params: Promise<{ orgId: string; viewId: string }> };

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  shared: z.boolean().optional(),
});

/** Owner or org admin may mutate a saved view; anyone with ITEM_READ may read a
 *  shared one. */
async function loadWritable(orgId: string, viewId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return { error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { error: new Response("Unauthorized", { status: 401 }) };
  requirePermission(ctx, Permission.ITEM_READ);

  const view = await prisma.savedView.findFirst({
    where: { id: viewId, orgId },
    select: { id: true, ownerId: true, name: true },
  });
  if (!view) return { error: new Response("Not found", { status: 404 }) };

  const isAdminOrOwner = ctx.orgRole === "ADMIN" || ctx.orgRole === "OWNER";
  if (view.ownerId !== ctx.userId && !isAdminOrOwner) {
    return { error: new Response("Forbidden", { status: 403 }) };
  }
  return { ctx, view };
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, viewId } = await params;
    const r = await loadWritable(orgId, viewId);
    if (r.error) return r.error;

    const data = updateSchema.parse(await request.json());

    // Renaming into an existing name (for THIS owner) is a clean 409.
    if (data.name && data.name !== r.view.name) {
      const clash = await prisma.savedView.findFirst({
        where: { ownerId: r.view.ownerId, name: data.name, id: { not: viewId } },
        select: { id: true },
      });
      if (clash) {
        return new Response(
          JSON.stringify({ error: "A saved view with that name already exists." }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    const updated = await prisma.savedView.update({
      where: { id: viewId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.filter !== undefined ? { filter: data.filter as Prisma.InputJsonValue } : {}),
        ...(data.shared !== undefined ? { shared: data.shared } : {}),
      },
      select: { id: true, name: true, filter: true, shared: true },
    });
    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, viewId } = await params;
    const r = await loadWritable(orgId, viewId);
    if (r.error) return r.error;

    await prisma.savedView.delete({ where: { id: viewId } });
    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
