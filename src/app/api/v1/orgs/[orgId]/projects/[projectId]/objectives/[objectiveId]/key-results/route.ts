import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireAccess } from "@/lib/abac/require-access";
import { handleApiError } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { createKeyResult } from "./route.contract";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; objectiveId: string }>;
};

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, createKeyResult);
    const { params: { orgId, projectId, objectiveId }, body: data } = await parseRequest(createKeyResult, request, params);
    await requireProjectVisible(ctx, projectId);

    // Scope check: the objective must belong to this org + project.
    const objective = await prisma.objective.findFirst({
      where: { id: objectiveId, orgId, projectId },
    });
    if (!objective) return problem(404, "not_found", undefined, { request });

    // Resource-aware authz (OKR_CREATE + any narrowing deny policy) on the
    // parent objective. Identical to requirePermission until a policy references
    // OKR_CREATE.
    await requireAccess(ctx, "OKR_CREATE", {
      ownerId: objective.ownerId,
      projectId: objective.projectId,
      objectiveId,
    });

    // Append to the end of the existing key results.
    const last = await prisma.keyResult.findFirst({
      where: { objectiveId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const sortOrder = last ? last.sortOrder + 1 : 0;

    const createdKr = await prisma.keyResult.create({
      data: {
        objectiveId,
        title: data.title,
        startValue: data.startValue,
        currentValue: data.currentValue,
        targetValue: data.targetValue,
        unit: data.unit ?? "",
        lowerIsBetter: data.lowerIsBetter,
        status: data.status,
        sortOrder,
      },
    });

    return respond(createKeyResult, 201, createdKr);
  } catch (e) {
    return handleApiError(e, request);
  }
}
