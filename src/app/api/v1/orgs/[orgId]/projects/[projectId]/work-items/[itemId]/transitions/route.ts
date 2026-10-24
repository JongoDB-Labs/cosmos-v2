import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { orgContext } from "@/lib/openapi/org-context";
import { requireAccess } from "@/lib/abac/require-access";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { handleApiError } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { listTransitions } from "@/lib/workflow/engine.server";
import { listItemTransitions } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; itemId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p } = await parseRequest(listItemTransitions, request, params);
    const { ctx } = await orgContext(p.orgId, listItemTransitions);
    // The project first (a key's project scope, team-scoped access), so a
    // caller who can't see the project can't learn what's in it, or whether an
    // item id exists there.
    await requireProjectRead(ctx, p.projectId, "ITEM_UPDATE");

    const item = await prisma.workItem.findFirst({ where: { id: p.itemId, orgId: p.orgId, projectId: p.projectId } });
    if (!item) return problem(404, "not_found", "Work item not found", { request });
    // Transitions are edits: whoever may not edit the item is offered none.
    await requireAccess(ctx, "ITEM_UPDATE", { createdById: item.createdById, assigneeId: item.assigneeId, projectId: p.projectId });

    const transitions = await prisma.$transaction((tx) =>
      listTransitions(tx, { orgId: p.orgId, projectId: p.projectId, actor: ctx, item }),
    );
    return respond(listItemTransitions, 200, transitions);
  } catch (error) {
    return handleApiError(error, request);
  }
}
