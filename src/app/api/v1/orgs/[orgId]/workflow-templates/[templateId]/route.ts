import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError, getIpAddress, success } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { parseRequest } from "@/lib/openapi/respond";
import { orgContext } from "@/lib/openapi/org-context";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { deleteWorkflow } from "@/lib/workflow/versions.server";
import { deleteWorkflowTemplate } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; templateId: string }> };

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p } = await parseRequest(deleteWorkflowTemplate, request, params);
    const { ctx } = await orgContext(p.orgId, deleteWorkflowTemplate);
    requirePermission(ctx, Permission.WORKFLOW_MANAGE);
    await prisma.$transaction((tx) => deleteWorkflow(tx, { orgId: p.orgId, projectId: null }, p.templateId));
    await logAudit({
      orgId: p.orgId,
      userId: ctx.userId,
      action: "workflow.template_deleted",
      entity: "workflow",
      entityId: p.templateId,
      ipAddress: getIpAddress(request),
    });
    return success({ ok: true as const });
  } catch (error) {
    return handleApiError(error, request);
  }
}
