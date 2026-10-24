import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError, getIpAddress, success } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { parseRequest } from "@/lib/openapi/respond";
import { workflowOrgContext } from "@/lib/workflow/route-auth.server";
import { deleteWorkflow } from "@/lib/workflow/versions.server";
import { deleteWorkflowTemplate } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; templateId: string }> };

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p } = await parseRequest(deleteWorkflowTemplate, request, params);
    const auth = await workflowOrgContext(request, p.orgId, "manage");
    if ("response" in auth) return auth.response;
    await prisma.$transaction((tx) => deleteWorkflow(tx, { orgId: p.orgId, projectId: null }, p.templateId));
    await logAudit({
      orgId: p.orgId,
      userId: auth.ctx.userId,
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
