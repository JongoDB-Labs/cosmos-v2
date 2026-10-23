import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { handleApiError } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { listTransitions } from "@/lib/workflow/engine.server";
import { listItemTransitions } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; itemId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p } = await parseRequest(listItemTransitions, request, params);
    const org = await prisma.organization.findUnique({ where: { id: p.orgId } });
    if (!org) return problem(404, "not_found", "Organization not found", { request });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return problem(401, "unauthorized", undefined, { request });

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
