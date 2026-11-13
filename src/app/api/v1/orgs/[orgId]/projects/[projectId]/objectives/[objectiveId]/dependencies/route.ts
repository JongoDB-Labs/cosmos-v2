import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";
import { requireAccess } from "@/lib/abac/require-access";
import { handleApiError } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { createObjectiveDependency } from "@/lib/okr/dependencies.server";
import { addObjectiveDependency } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; objectiveId: string }> };

/** POST: this objective needs `dependsOnId` first. The rules live in lib/okr/dependencies.server. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, addObjectiveDependency);
    const { params: { orgId, projectId, objectiveId }, body } = await parseRequest(addObjectiveDependency, request, params);
    await requireProjectVisible(ctx, projectId);

    const existing = await prisma.objective.findFirst({
      where: { id: objectiveId, orgId, projectId },
      select: { ownerId: true },
    });
    if (!existing) return problem(404, "not_found", undefined, { request });
    // Editing this objective, as PUT does.
    await requireAccess(ctx, "OKR_UPDATE", { ownerId: existing.ownerId, projectId });

    return respond(addObjectiveDependency, 200, await createObjectiveDependency(ctx, objectiveId, body.dependsOnId));
  } catch (e) {
    return handleApiError(e, request);
  }
}
