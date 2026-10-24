import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireAccess } from "@/lib/abac/require-access";
import { handleApiError } from "@/lib/api-helpers";
import { krFraction } from "@/lib/okr/progress";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { deleteKeyResult, updateKeyResult } from "./route.contract";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; krId: string }>;
};

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, updateKeyResult);
    const { params: { orgId, projectId, krId }, body: data } = await parseRequest(updateKeyResult, request, params);
    await requireProjectVisible(ctx, projectId);

    // Scope check: the KR's objective must belong to this org + project.
    const kr = await prisma.keyResult.findFirst({
      where: { id: krId, objective: { orgId, projectId } },
      include: { objective: { select: { projectId: true } } },
    });
    if (!kr) return problem(404, "not_found", undefined, { request });

    // Resource-aware authz (OKR_UPDATE + any narrowing deny policy). The KR's
    // project comes from the parent objective. Identical to requirePermission
    // until a policy references OKR_UPDATE.
    await requireAccess(ctx, "OKR_UPDATE", {
      ownerId: kr.ownerId,
      projectId: kr.objective.projectId,
      objectiveId: kr.objectiveId,
    });

    const updated = await prisma.keyResult.update({
      where: { id: krId },
      data: {
        ...(data.currentValue !== undefined && { currentValue: data.currentValue }),
        ...(data.targetValue !== undefined && { targetValue: data.targetValue }),
        ...(data.startValue !== undefined && { startValue: data.startValue }),
        ...(data.title !== undefined && { title: data.title }),
        ...(data.unit !== undefined && { unit: data.unit }),
        ...(data.lowerIsBetter !== undefined && { lowerIsBetter: data.lowerIsBetter }),
        ...(data.status !== undefined && { status: data.status }),
      },
    });

    // Recompute the parent objective's progress from all its key results.
    const siblings = await prisma.keyResult.findMany({
      where: { objectiveId: kr.objectiveId },
      select: { startValue: true, currentValue: true, targetValue: true, lowerIsBetter: true },
    });
    const progress =
      siblings.length === 0
        ? 0
        : Math.round(
            (siblings.reduce(
              (sum, s) => sum + krFraction(s.startValue, s.currentValue, s.targetValue, s.lowerIsBetter),
              0,
            ) /
              siblings.length) *
              100,
          );
    await prisma.objective.update({
      where: { id: kr.objectiveId },
      data: { progress },
    });

    return respond(updateKeyResult, 200, updated);
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, deleteKeyResult);
    const { params: { orgId, projectId, krId } } = await parseRequest(deleteKeyResult, request, params);
    await requireProjectVisible(ctx, projectId);

    const kr = await prisma.keyResult.findFirst({
      where: { id: krId, objective: { orgId, projectId } },
      include: { objective: { select: { projectId: true } } },
    });
    if (!kr) return problem(404, "not_found", undefined, { request });

    // Resource-aware authz (OKR_DELETE + any narrowing deny policy). Deleting a
    // KR requires OKR_DELETE, matching the sibling objective DELETE — a MEMBER
    // holds OKR_UPDATE but NOT OKR_DELETE and must not be able to delete KRs.
    await requireAccess(ctx, "OKR_DELETE", {
      ownerId: kr.ownerId,
      projectId: kr.objective.projectId,
      objectiveId: kr.objectiveId,
    });

    await prisma.keyResult.delete({ where: { id: krId } });

    return respond(deleteKeyResult, 200, { id: krId });
  } catch (e) {
    return handleApiError(e, request);
  }
}
