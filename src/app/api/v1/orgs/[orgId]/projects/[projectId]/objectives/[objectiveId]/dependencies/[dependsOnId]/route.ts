import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";
import { requireAccess } from "@/lib/abac/require-access";
import { handleApiError } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { deleteObjectiveDependency } from "@/lib/okr/dependencies.server";
import { removeObjectiveDependency } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; objectiveId: string; dependsOnId: string }> };

/** DELETE: this objective no longer needs `dependsOnId` first. */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, removeObjectiveDependency);
    const { params: { orgId, projectId, objectiveId, dependsOnId } } = await parseRequest(removeObjectiveDependency, request, params);
    await requireProjectVisible(ctx, projectId);

    const existing = await prisma.objective.findFirst({
      where: { id: objectiveId, orgId, projectId },
      select: { ownerId: true },
    });
    if (!existing) return problem(404, "not_found", undefined, { request });
    await requireAccess(ctx, "OKR_UPDATE", { ownerId: existing.ownerId, projectId });

    if (!(await deleteObjectiveDependency(ctx, objectiveId, dependsOnId))) return problem(404, "not_found", undefined, { request });
    return respond(removeObjectiveDependency, 200, { id: dependsOnId });
  } catch (e) {
    return handleApiError(e, request);
  }
}
