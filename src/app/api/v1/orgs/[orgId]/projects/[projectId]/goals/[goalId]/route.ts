import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { deleteGoal, updateGoal } from "./route.contract";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; goalId: string }>;
};

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, updateGoal);
    const { params: { orgId, projectId, goalId }, body: data } = await parseRequest(updateGoal, request, params);
    await requireProjectVisible(ctx, projectId);
    await requireProjectManage(ctx, projectId, Permission.OKR_UPDATE);

    const existing = await prisma.goal.findFirst({
      where: { id: goalId, orgId, projectId },
    });
    if (!existing) return problem(404, "not_found", undefined, { request });

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

    return respond(updateGoal, 200, updated);
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, deleteGoal);
    const { params: { orgId, projectId, goalId } } = await parseRequest(deleteGoal, request, params);
    await requireProjectVisible(ctx, projectId);
    await requireProjectManage(ctx, projectId, Permission.OKR_DELETE);

    const existing = await prisma.goal.findFirst({
      where: { id: goalId, orgId, projectId },
    });
    if (!existing) return problem(404, "not_found", undefined, { request });

    // GoalLink rows cascade-delete via the FK.
    await prisma.goal.delete({ where: { id: goalId } });

    return respond(deleteGoal, 200, { id: goalId });
  } catch (e) {
    return handleApiError(e, request);
  }
}
