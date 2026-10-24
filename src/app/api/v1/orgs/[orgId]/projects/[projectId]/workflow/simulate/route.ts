import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError, success } from "@/lib/api-helpers";
import { parseRequest } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { workflowProjectContext } from "@/lib/workflow/route-auth.server";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";

import { simulateTransitions } from "@/lib/workflow/engine.server";
import { parseDefinition } from "@/lib/workflow/versions.server";
import { simulateWorkflow } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p, body } = await parseRequest(simulateWorkflow, request, params);
    const ctx = await workflowProjectContext(p, simulateWorkflow);
    // A workflow manager's debugging tool: it shows another member's view of an item.
    await requireProjectManage(ctx, p.projectId, Permission.WORKFLOW_MANAGE);
    const item = await prisma.workItem.findFirst({ where: { id: body.itemId, orgId: p.orgId, projectId: p.projectId } });
    if (!item) return problem(404, "not_found", "Work item not found", { request });
    // Only to evaluate the workflow's rules for that member; nothing is done as them.
    const actor = body.actorUserId && body.actorUserId !== ctx.userId
      ? await loadMemberAuthContext(p.orgId, body.actorUserId)
      : ctx;
    if (!actor) return problem(404, "not_found", "That person isn't a member of this organization", { request });
    const definition = body.definition ? parseDefinition(body.definition) : undefined;
    return success(
      await prisma.$transaction((tx) =>
        simulateTransitions(tx, { orgId: p.orgId, projectId: p.projectId, actor, item, definition }),
      ),
    );
  } catch (error) {
    return handleApiError(error, request);
  }
}
