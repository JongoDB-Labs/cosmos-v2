import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { deleteKpi, updateKpi } from "./route.contract";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; kpiId: string }>;
};

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, updateKpi);
    const { params: { orgId, projectId, kpiId }, body: data } = await parseRequest(updateKpi, request, params);
    await requireProjectManage(ctx, projectId, Permission.PROJECT_UPDATE);

    const existing = await prisma.kpi.findFirst({
      where: { id: kpiId, orgId, projectId },
    });
    if (!existing) return problem(404, "not_found", undefined, { request });

    const updated = await prisma.kpi.update({
      where: { id: kpiId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.unit !== undefined && { unit: data.unit }),
        ...(data.targetValue !== undefined && { targetValue: data.targetValue }),
        ...(data.currentValue !== undefined && {
          currentValue: data.currentValue,
        }),
        ...(data.direction !== undefined && { direction: data.direction }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
        ...(data.autoSource !== undefined && { autoSource: data.autoSource }),
        ...(data.autoWindowDays !== undefined && {
          autoWindowDays: data.autoWindowDays ?? null,
        }),
      },
      include: { dataPoints: { orderBy: { recordedAt: "asc" } } },
    });

    return respond(updateKpi, 200, updated);
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, deleteKpi);
    const { params: { orgId, projectId, kpiId } } = await parseRequest(deleteKpi, request, params);
    await requireProjectManage(ctx, projectId, Permission.PROJECT_UPDATE);

    const existing = await prisma.kpi.findFirst({
      where: { id: kpiId, orgId, projectId },
    });
    if (!existing) return problem(404, "not_found", undefined, { request });

    // Data points cascade-delete via the FK.
    await prisma.kpi.delete({ where: { id: kpiId } });

    return respond(deleteKpi, 200, { id: kpiId });
  } catch (e) {
    return handleApiError(e, request);
  }
}
