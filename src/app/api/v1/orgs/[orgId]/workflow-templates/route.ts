import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError, getIpAddress, success } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { parseRequest } from "@/lib/openapi/respond";
import { orgContext } from "@/lib/openapi/org-context";
import { requirePermission } from "@/lib/rbac/check";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { problem } from "@/lib/openapi/problem";
import { Permission } from "@/lib/rbac/permissions";
import { createTemplateFrom, listTemplates } from "@/lib/workflow/versions.server";
import { createWorkflowTemplate, listWorkflowTemplates } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p } = await parseRequest(listWorkflowTemplates, request, params);
    const { ctx } = await orgContext(p.orgId, listWorkflowTemplates);
    requirePermission(ctx, Permission.ITEM_READ);
    return success(await prisma.$transaction((tx) => listTemplates(tx, p.orgId)));
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p, body } = await parseRequest(createWorkflowTemplate, request, params);
    const { ctx } = await orgContext(p.orgId, createWorkflowTemplate);
    requirePermission(ctx, Permission.WORKFLOW_MANAGE);
    // The source is a project's workflow: the caller must be able to see that
    // project (a key's project scope, team-scoped access), or it is not found.
    const source = await prisma.workflow.findFirst({
      where: { id: body.fromWorkflowId, orgId: p.orgId, projectId: { not: null } },
      select: { projectId: true },
    });
    if (!source) return problem(404, "not_found", "Workflow not found", { request });
    await requireProjectRead(ctx, source.projectId!, "ITEM_READ");
    const id = await prisma.$transaction((tx) =>
      createTemplateFrom(tx, { orgId: p.orgId, workflowId: body.fromWorkflowId, name: body.name, description: body.description, actorId: ctx.userId }),
    );
    await logAudit({
      orgId: p.orgId,
      userId: ctx.userId,
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
