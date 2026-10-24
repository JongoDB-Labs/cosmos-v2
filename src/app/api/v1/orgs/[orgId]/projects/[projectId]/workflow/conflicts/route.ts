import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError, success } from "@/lib/api-helpers";
import { parseRequest } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { Permission } from "@/lib/rbac/permissions";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireProjectRead, requireProjectVisible } from "@/lib/rbac/require-project-read";
import { workflowProjectContext } from "@/lib/workflow/route-auth.server";
import { listBackfillConflicts, resolveBackfillConflict } from "@/lib/workflow/column-categories.server";
import { listStatusConflicts, resolveStatusConflict } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p } = await parseRequest(listStatusConflicts, request, params);
    const ctx = await workflowProjectContext(p, listStatusConflicts);
    await requireProjectRead(ctx, p.projectId, "ITEM_READ");
    return success(await listBackfillConflicts(prisma, p.projectId));
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p, body } = await parseRequest(resolveStatusConflict, request, params);
    const ctx = await workflowProjectContext(p, resolveStatusConflict);
    await requireProjectVisible(ctx, p.projectId);
    await requireProjectManage(ctx, p.projectId, Permission.WORKFLOW_MANAGE);
    const status = await prisma.workflowStatus.findUnique({ where: { projectId_key: { projectId: p.projectId, key: body.key } }, select: { id: true } });
    if (!status) return problem(404, "not_found", "Status not found", { request });
    const category = await prisma.$transaction((tx) =>
      resolveBackfillConflict(tx, { orgId: p.orgId, projectId: p.projectId, key: body.key, take: body.take, actorId: ctx.userId }),
    );
    // resolveBackfillConflict writes the audit row that closes the conflict.
    return success({ category });
  } catch (error) {
    return handleApiError(error, request);
  }
}
