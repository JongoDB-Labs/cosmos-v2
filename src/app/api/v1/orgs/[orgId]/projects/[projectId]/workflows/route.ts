import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError, getIpAddress, success } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { parseRequest } from "@/lib/openapi/respond";
import { workflowProjectContext } from "@/lib/workflow/route-auth.server";
import { createWorkflow, listProjectWorkflows } from "@/lib/workflow/versions.server";
import { createProjectWorkflow, listProjectWorkflows as listContract } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p } = await parseRequest(listContract, request, params);
    const auth = await workflowProjectContext(request, p, "read");
    if ("response" in auth) return auth.response;
    return success(await prisma.$transaction((tx) => listProjectWorkflows(tx, p.projectId)));
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p, body } = await parseRequest(createProjectWorkflow, request, params);
    const auth = await workflowProjectContext(request, p, "manage");
    if ("response" in auth) return auth.response;
    const id = await prisma.$transaction((tx) =>
      createWorkflow(tx, { orgId: p.orgId, projectId: p.projectId, actorId: auth.ctx.userId, ...body }),
    );
    await logAudit({
      orgId: p.orgId,
      userId: auth.ctx.userId,
      action: "workflow.created",
      entity: "workflow",
      entityId: id,
      metadata: { projectId: p.projectId, from: body.from.kind },
      ipAddress: getIpAddress(request),
    });
    return success({ id }, 201);
  } catch (error) {
    return handleApiError(error, request);
  }
}
