import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError, getIpAddress, success } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { parseRequest } from "@/lib/openapi/respond";
import { workflowProjectContext } from "@/lib/workflow/route-auth.server";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import { restoreVersion } from "@/lib/workflow/versions.server";
import { restoreWorkflowVersion } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; workflowId: string; version: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p } = await parseRequest(restoreWorkflowVersion, request, params);
    const ctx = await workflowProjectContext(p, restoreWorkflowVersion);
    await requireProjectManage(ctx, p.projectId, Permission.WORKFLOW_MANAGE);
    const draft = await prisma.$transaction((tx) =>
      restoreVersion(tx, { orgId: p.orgId, projectId: p.projectId }, p.workflowId, p.version),
    );
    await logAudit({
      orgId: p.orgId,
      userId: ctx.userId,
      action: "workflow.version_restored",
      entity: "workflow",
      entityId: p.workflowId,
      metadata: { projectId: p.projectId, from: String(p.version), draft: String(draft.version) },
      ipAddress: getIpAddress(request),
    });
    return success(draft);
  } catch (error) {
    return handleApiError(error, request);
  }
}
