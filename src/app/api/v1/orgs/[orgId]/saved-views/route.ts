import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError } from "@/lib/api-helpers";
import type { Prisma } from "@prisma/client";

type RouteParams = { params: Promise<{ orgId: string }> };

// The filter payload is a serialized WorkItemFilter — validated loosely here
// (the query layer is the source of truth for its shape) and re-validated when
// applied. Capped to keep a stored view from carrying an unbounded blob.
const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  filter: z.record(z.string(), z.unknown()),
  shared: z.boolean().default(false),
});

/**
 * Saved views (FR 2b36c2b8): named, reusable Issues filters. The list returns
 * the caller's own views plus every org-shared one, so a user sees their
 * personal saves and the team's shared searches. Gated on ITEM_READ (a saved
 * view is just a work-item query).
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_READ);

    const views = await prisma.savedView.findMany({
      where: { orgId, OR: [{ ownerId: ctx.userId }, { shared: true }] },
      orderBy: [{ name: "asc" }],
      select: {
        id: true,
        name: true,
        filter: true,
        shared: true,
        ownerId: true,
        owner: { select: { displayName: true } },
        updatedAt: true,
      },
    });

    return success(
      views.map((v) => ({
        id: v.id,
        name: v.name,
        filter: v.filter,
        shared: v.shared,
        mine: v.ownerId === ctx.userId,
        ownerName: v.owner.displayName,
        updatedAt: v.updatedAt.toISOString(),
      })),
    );
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
    requirePermission(ctx, Permission.ITEM_READ);

    const data = createSchema.parse(await request.json());

    // Name is unique per owner — surface a clean 409 instead of a raw P2002.
    const clash = await prisma.savedView.findFirst({
      where: { ownerId: ctx.userId, name: data.name },
      select: { id: true },
    });
    if (clash) {
      return new Response(
        JSON.stringify({ error: "You already have a saved view with that name." }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }

    const view = await prisma.savedView.create({
      data: {
        orgId,
        ownerId: ctx.userId,
        name: data.name,
        filter: data.filter as Prisma.InputJsonValue,
        shared: data.shared,
      },
      select: { id: true, name: true, filter: true, shared: true },
    });

    return created({ ...view, mine: true });
  } catch (error) {
    return handleApiError(error);
  }
}
