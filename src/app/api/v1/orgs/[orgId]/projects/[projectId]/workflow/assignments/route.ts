import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError, getIpAddress, success } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { parseRequest } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { workflowProjectContext } from "@/lib/workflow/route-auth.server";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import { assignWorkflow } from "@/lib/workflow/versions.server";
import { startMigrations } from "@/lib/workflow/migrate.server";
import { assignProjectWorkflow } from "./route.contract";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p, body } = await parseRequest(assignProjectWorkflow, request, params);
    const ctx = await workflowProjectContext(p, assignProjectWorkflow);
    await requireProjectVisible(ctx, p.projectId);
    await requireProjectManage(ctx, p.projectId, Permission.WORKFLOW_MANAGE);
    if (body.workItemTypeId) {
      const type = await prisma.workItemType.findFirst({
        where: { id: body.workItemTypeId, OR: [{ orgId: p.orgId }, { orgId: null }] },
        select: { id: true },
      });
      if (!type) return problem(404, "not_found", "Work item type not found", { request });
    }
    const result = await prisma.$transaction((tx) => assignWorkflow(tx, { orgId: p.orgId, projectId: p.projectId, ...body }));
    await logAudit({
      orgId: p.orgId,
      userId: ctx.userId,
      action: "workflow.assigned",
      entity: "project",
      entityId: p.projectId,
      metadata: {
        workItemTypeId: body.workItemTypeId ?? "default",
        workflowId: body.workflowId ?? "open",
        ...(Object.keys(result.migrationMap).length > 0 && { migrationMap: JSON.stringify(result.migrationMap) }),
      },
      ipAddress: getIpAddress(request),
    });
    if (Object.keys(result.migrationMap).length > 0) startMigrations(p.orgId, p.projectId);
    return success(result);
  } catch (error) {
    return handleApiError(error, request);
  }
}
