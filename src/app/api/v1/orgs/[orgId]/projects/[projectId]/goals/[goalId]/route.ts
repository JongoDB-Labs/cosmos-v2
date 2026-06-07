import { NextRequest } from "next/server";
import { z } from "zod";
import { GoalStatus, GoalProgressMode } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; goalId: string }>;
};

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  status: z.nativeEnum(GoalStatus).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  progressMode: z.nativeEnum(GoalProgressMode).optional(),
  targetDate: z.string().datetime().nullish(),
  ownerId: z.string().uuid().nullish(),
  sortOrder: z.number().int().optional(),
});

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, goalId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.OKR_UPDATE);

    const existing = await prisma.goal.findFirst({
      where: { id: goalId, orgId, projectId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const data = updateSchema.parse(await request.json());

    const updated = await prisma.goal.update({
      where: { id: goalId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.progress !== undefined && { progress: data.progress }),
        ...(data.progressMode !== undefined && { progressMode: data.progressMode }),
        ...(data.targetDate !== undefined && {
          targetDate: data.targetDate ? new Date(data.targetDate) : null,
        }),
        ...(data.ownerId !== undefined && { ownerId: data.ownerId }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
      },
      include: { links: { orderBy: { createdAt: "asc" } } },
    });

    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, goalId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.OKR_DELETE);

    const existing = await prisma.goal.findFirst({
      where: { id: goalId, orgId, projectId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // GoalLink rows cascade-delete via the FK.
    await prisma.goal.delete({ where: { id: goalId } });

    return success({ id: goalId });
  } catch (e) {
    return handleApiError(e);
  }
}
