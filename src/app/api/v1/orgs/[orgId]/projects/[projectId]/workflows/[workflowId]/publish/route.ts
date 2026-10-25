import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError, getIpAddress, success } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { parseRequest } from "@/lib/openapi/respond";
import { workflowProjectContext } from "@/lib/workflow/route-auth.server";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireProjectRead, requireProjectVisible } from "@/lib/rbac/require-project-read";
import { Permission } from "@/lib/rbac/permissions";
import { previewPublish, publishDraft } from "@/lib/workflow/versions.server";
import { startMigrations } from "@/lib/workflow/migrate.server";
import { previewWorkflowPublish, publishWorkflow } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; workflowId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p } = await parseRequest(previewWorkflowPublish, request, params);
    const ctx = await workflowProjectContext(p, previewWorkflowPublish);
    await requireProjectRead(ctx, p.projectId, "ITEM_READ");
    const { draft, issues, diff } = await prisma.$transaction((tx) =>
      previewPublish(tx, { orgId: p.orgId, projectId: p.projectId }, p.workflowId),
    );
    return success({ version: draft.version, issues, diff });
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p, body } = await parseRequest(publishWorkflow, request, params);
    const ctx = await workflowProjectContext(p, publishWorkflow);
    await requireProjectVisible(ctx, p.projectId);
    await requireProjectManage(ctx, p.projectId, Permission.WORKFLOW_MANAGE);
    const result = await prisma.$transaction((tx) =>
      publishDraft(tx, { orgId: p.orgId, projectId: p.projectId }, p.workflowId, {
        actorId: ctx.userId,
        migrationMap: body.migrationMap,
      }),
    );
    await logAudit({
      orgId: p.orgId,
      userId: ctx.userId,
      action: "workflow.published",
      entity: "workflow",
      entityId: p.workflowId,
      metadata: {
        projectId: p.projectId,
        version: String(result.version),
        removedStatuses: result.diff.removedStatuses.map((r) => r.key).join(","),
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
