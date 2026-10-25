import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { handleApiError } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { ProblemError } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { getWorkItemWatch, unwatchWorkItem, watchWorkItem } from "./route.contract";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; itemId: string }>;
};

/**
 * Watch / unwatch a work item (FR 8702c9b8). Explicit opt-in — the caller
 * follows the item so it shows up in their "watched tickets" surfaces. Gated on
 * ITEM_READ (you can watch anything you can see). Idempotent: POST is a no-op if
 * already watching, DELETE a no-op if not.
 */
async function requireItem(ctx: AuthContext, ids: { orgId: string; projectId: string; itemId: string }) {
  await requireProjectRead(ctx, ids.projectId, "ITEM_READ");
  const item = await prisma.workItem.findFirst({
    where: { id: ids.itemId, orgId: ids.orgId, projectId: ids.projectId },
    select: { id: true },
  });
  if (!item) throw new ProblemError(404, "not_found");
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, getWorkItemWatch);
    const { params: ids } = await parseRequest(getWorkItemWatch, request, params);
    await requireItem(ctx, ids);

    const [mine, count] = await Promise.all([
      prisma.workItemWatcher.findUnique({
        where: { workItemId_userId: { workItemId: ids.itemId, userId: ctx.userId } },
        select: { id: true },
      }),
      prisma.workItemWatcher.count({ where: { workItemId: ids.itemId } }),
    ]);
    return respond(getWorkItemWatch, 200, { watching: !!mine, watcherCount: count });
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, watchWorkItem);
    const { params: ids } = await parseRequest(watchWorkItem, request, params);
    await requireItem(ctx, ids);

    await prisma.workItemWatcher.upsert({
      where: { workItemId_userId: { workItemId: ids.itemId, userId: ctx.userId } },
      create: { orgId: ids.orgId, workItemId: ids.itemId, userId: ctx.userId },
      update: {},
    });
    return respond(watchWorkItem, 200, { watching: true });
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, unwatchWorkItem);
    const { params: ids } = await parseRequest(unwatchWorkItem, request, params);
    await requireItem(ctx, ids);

    await prisma.workItemWatcher.deleteMany({
      where: { workItemId: ids.itemId, userId: ctx.userId },
    });
    return respond(unwatchWorkItem, 200, { watching: false });
  } catch (error) {
    return handleApiError(error, request);
  }
}
