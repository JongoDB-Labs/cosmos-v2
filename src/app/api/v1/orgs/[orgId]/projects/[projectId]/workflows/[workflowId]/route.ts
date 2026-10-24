import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError, getIpAddress, success } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { parseRequest } from "@/lib/openapi/respond";
import { workflowProjectContext } from "@/lib/workflow/route-auth.server";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { Permission } from "@/lib/rbac/permissions";
import { deleteWorkflow, getWorkflow, updateWorkflowMeta } from "@/lib/workflow/versions.server";
import { deleteProjectWorkflow, getProjectWorkflow, updateProjectWorkflow } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; workflowId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p } = await parseRequest(getProjectWorkflow, request, params);
    const ctx = await workflowProjectContext(p, getProjectWorkflow);
    await requireProjectRead(ctx, p.projectId, "ITEM_READ");
    return success(await prisma.$transaction((tx) => getWorkflow(tx, { orgId: p.orgId, projectId: p.projectId }, p.workflowId)));
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p, body } = await parseRequest(updateProjectWorkflow, request, params);
    const ctx = await workflowProjectContext(p, updateProjectWorkflow);
    await requireProjectManage(ctx, p.projectId, Permission.WORKFLOW_MANAGE);
    await prisma.$transaction((tx) => updateWorkflowMeta(tx, { orgId: p.orgId, projectId: p.projectId }, p.workflowId, body));
    await logAudit({
      orgId: p.orgId,
      userId: ctx.userId,
      action: "workflow.updated",
      entity: "workflow",
      entityId: p.workflowId,
      metadata: { projectId: p.projectId, fields: Object.keys(body).join(","), ...(body.enforcement && { enforcement: body.enforcement }) },
      ipAddress: getIpAddress(request),
    });
    return success({ ok: true as const });
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p } = await parseRequest(deleteProjectWorkflow, request, params);
    const ctx = await workflowProjectContext(p, deleteProjectWorkflow);
    await requireProjectManage(ctx, p.projectId, Permission.WORKFLOW_MANAGE);
    await prisma.$transaction((tx) => deleteWorkflow(tx, { orgId: p.orgId, projectId: p.projectId }, p.workflowId));
    await logAudit({
      orgId: p.orgId,
      userId: ctx.userId,
      action: "workflow.deleted",
      entity: "workflow",
      entityId: p.workflowId,
      metadata: { projectId: p.projectId },
      ipAddress: getIpAddress(request),
    });
    return success({ ok: true as const });
  } catch (error) {
    return handleApiError(error, request);
  }
}
