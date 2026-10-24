import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError, getIpAddress, success } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { parseRequest } from "@/lib/openapi/respond";
import { workflowOrgContext } from "@/lib/workflow/route-auth.server";
import { createTemplateFrom, listTemplates } from "@/lib/workflow/versions.server";
import { createWorkflowTemplate, listWorkflowTemplates } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p } = await parseRequest(listWorkflowTemplates, request, params);
    const auth = await workflowOrgContext(request, p.orgId, "read");
    if ("response" in auth) return auth.response;
    return success(await prisma.$transaction((tx) => listTemplates(tx, p.orgId)));
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p, body } = await parseRequest(createWorkflowTemplate, request, params);
    const auth = await workflowOrgContext(request, p.orgId, "manage");
    if ("response" in auth) return auth.response;
    const id = await prisma.$transaction((tx) =>
      createTemplateFrom(tx, { orgId: p.orgId, workflowId: body.fromWorkflowId, name: body.name, description: body.description, actorId: auth.ctx.userId }),
    );
    await logAudit({
      orgId: p.orgId,
      userId: auth.ctx.userId,
      action: "workflow.template_created",
      entity: "workflow",
      entityId: id,
      metadata: { fromWorkflowId: body.fromWorkflowId },
      ipAddress: getIpAddress(request),
    });
    return success({ id }, 201);
  } catch (error) {
    return handleApiError(error, request);
  }
}
