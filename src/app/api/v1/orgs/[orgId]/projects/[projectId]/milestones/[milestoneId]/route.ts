import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { deleteMilestone, updateMilestone } from "./route.contract";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; milestoneId: string }>;
};

function loadMilestone(orgId: string, projectId: string, milestoneId: string) {
  return prisma.milestone.findFirst({
    where: { id: milestoneId, orgId, projectId },
  });
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, updateMilestone);
    const { params: { orgId, projectId, milestoneId }, body: data } = await parseRequest(updateMilestone, request, params);
    await requireProjectVisible(ctx, projectId);
    await requireProjectManage(ctx, projectId, Permission.PROJECT_UPDATE);

    const existing = await loadMilestone(orgId, projectId, milestoneId);
    if (!existing) return problem(404, "not_found", undefined, { request });

    const updated = await prisma.milestone.update({
      where: { id: milestoneId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.dueDate !== undefined && { dueDate: new Date(data.dueDate) }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.autoStatus !== undefined && { autoStatus: data.autoStatus }),
        ...(data.completedAt !== undefined && {
          completedAt: data.completedAt ? new Date(data.completedAt) : null,
        }),
        ...(data.ownerId !== undefined && { ownerId: data.ownerId }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
      },
      include: { links: true },
    });

    return respond(updateMilestone, 200, updated);
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, deleteMilestone);
    const { params: { orgId, projectId, milestoneId } } = await parseRequest(deleteMilestone, request, params);
    await requireProjectVisible(ctx, projectId);
    await requireProjectManage(ctx, projectId, Permission.PROJECT_UPDATE);

    const existing = await loadMilestone(orgId, projectId, milestoneId);
    if (!existing) return problem(404, "not_found", undefined, { request });

    // Links cascade-delete via the FK.
    await prisma.milestone.delete({ where: { id: milestoneId } });

    return respond(deleteMilestone, 200, { id: milestoneId });
  } catch (e) {
    return handleApiError(e, request);
  }
}
