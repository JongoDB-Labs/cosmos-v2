import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; itemId: string }>;
};

/**
 * Watch / unwatch a work item (FR 8702c9b8). Explicit opt-in — the caller
 * follows the item so it shows up in their "watched tickets" surfaces. Gated on
 * ITEM_READ (you can watch anything you can see). Idempotent: POST is a no-op if
 * already watching, DELETE a no-op if not.
 */
async function resolve(orgId: string, projectId: string, itemId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return { error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { error: new Response("Unauthorized", { status: 401 }) };
  requirePermission(ctx, Permission.ITEM_READ);
  const item = await prisma.workItem.findFirst({
    where: { id: itemId, orgId, projectId },
    select: { id: true },
  });
  if (!item) return { error: new Response("Not found", { status: 404 }) };
  return { ctx };
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId } = await params;
    const r = await resolve(orgId, projectId, itemId);
    if (r.error) return r.error;

    const [mine, count] = await Promise.all([
      prisma.workItemWatcher.findUnique({
        where: { workItemId_userId: { workItemId: itemId, userId: r.ctx.userId } },
        select: { id: true },
      }),
      prisma.workItemWatcher.count({ where: { workItemId: itemId } }),
    ]);
    return success({ watching: !!mine, watcherCount: count });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId } = await params;
    const r = await resolve(orgId, projectId, itemId);
    if (r.error) return r.error;

    await prisma.workItemWatcher.upsert({
      where: { workItemId_userId: { workItemId: itemId, userId: r.ctx.userId } },
      create: { orgId, workItemId: itemId, userId: r.ctx.userId },
      update: {},
    });
    return success({ watching: true });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId } = await params;
    const r = await resolve(orgId, projectId, itemId);
    if (r.error) return r.error;

    await prisma.workItemWatcher.deleteMany({
      where: { workItemId: itemId, userId: r.ctx.userId },
    });
    return success({ watching: false });
  } catch (error) {
    return handleApiError(error);
  }
}
