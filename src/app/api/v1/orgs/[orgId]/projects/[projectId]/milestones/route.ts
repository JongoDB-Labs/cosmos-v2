import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { loadMilestonesWithDerived } from "@/lib/pm/schedule";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { createMilestone, listMilestones } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listMilestones);
    const { params: { orgId, projectId } } = await parseRequest(listMilestones, request, params);
    await requireProjectRead(ctx, projectId, "PROJECT_READ");

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return problem(404, "not_found", undefined, { request });

    const withDerived = await loadMilestonesWithDerived(orgId, projectId);
    return respond(listMilestones, 200, withDerived);
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, createMilestone);
    const { params: { orgId, projectId }, body: data } = await parseRequest(createMilestone, request, params);
    await requireProjectManage(ctx, projectId, Permission.PROJECT_UPDATE);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return problem(404, "not_found", undefined, { request });

    const maxSort = await prisma.milestone.aggregate({
      where: { orgId, projectId },
      _max: { sortOrder: true },
    });
    const sortOrder = (maxSort._max.sortOrder ?? -1) + 1;

    const createdMilestone = await prisma.milestone.create({
      data: {
        orgId,
        projectId,
        title: data.title,
        description: data.description ?? null,
        dueDate: new Date(data.dueDate),
        ownerId: data.ownerId ?? null,
        autoStatus: data.autoStatus ?? true,
        sortOrder,
      },
      include: { links: true },
    });

    return respond(createMilestone, 200, createdMilestone);
  } catch (e) {
    return handleApiError(e, request);
  }
}
