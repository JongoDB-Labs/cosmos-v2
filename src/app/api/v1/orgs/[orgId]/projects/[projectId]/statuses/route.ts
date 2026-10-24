import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { orgContext } from "@/lib/openapi/org-context";
import { requireProjectRead, requireProjectVisible } from "@/lib/rbac/require-project-read";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { ensureStatuses, loadStatuses, statusCounts, toStatusDto } from "@/lib/workflow/statuses.server";
import { createStatus, listStatuses } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    // Authenticate (and hold a key to the contract's scopes) before validating.
    const { ctx } = await orgContext((await params).orgId, listStatuses);
    const { params: p, query } = await parseRequest(listStatuses, request, params);

    const project = await prisma.project.findFirst({ where: { id: p.projectId, orgId: p.orgId }, select: { id: true } });
    if (!project) return problem(404, "not_found", "Project not found", { request });
    await requireProjectRead(ctx, p.projectId, "ITEM_READ");

    const rows = await loadStatuses(prisma, p.projectId, { includeArchived: query.archived === "true" });
    const counts = query.counts === "true" ? await statusCounts(prisma, p.projectId) : null;
    return respond(listStatuses, 200, rows.map((r) => toStatusDto(r, counts?.get(r.key) ?? (counts ? 0 : undefined))));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    // Authenticate (and hold a key to the contract's scopes) before validating.
    const { ctx } = await orgContext((await params).orgId, createStatus);
    const { params: p, body } = await parseRequest(createStatus, request, params);
    await requireProjectVisible(ctx, p.projectId);

    const project = await prisma.project.findFirst({ where: { id: p.projectId, orgId: p.orgId }, select: { id: true } });
    if (!project) return problem(404, "not_found", "Project not found", { request });
    // The same authority as adding a column: org-wide board update, or project
    // manager; and once the project runs a custom workflow, a new status is a
    // workflow change (design §6.4).
    await requireProjectManage(ctx, p.projectId, Permission.BOARD_UPDATE);
    if ((await prisma.workflowAssignment.count({ where: { projectId: p.projectId } })) > 0) {
      await requireProjectManage(ctx, p.projectId, Permission.WORKFLOW_MANAGE);
    }

    const existing = await prisma.workflowStatus.findUnique({
      where: { projectId_key: { projectId: p.projectId, key: body.key } },
      select: { id: true },
    });
    if (existing) return problem(409, "conflict", "This project already has a status with that key.", { request });

    const row = await prisma.$transaction(async (tx) => {
      await ensureStatuses(tx, { orgId: p.orgId, projectId: p.projectId }, [body]);
      return tx.workflowStatus.findUniqueOrThrow({ where: { projectId_key: { projectId: p.projectId, key: body.key } } });
    });

    await logAudit({
      orgId: p.orgId,
      userId: ctx.userId,
      action: "workflow.status_created",
      entity: "workflow_status",
      entityId: row.id,
      metadata: { projectId: p.projectId, key: row.key, category: row.category },
      ipAddress: getIpAddress(request),
    });
    return respond(createStatus, 201, toStatusDto(row));
  } catch (error) {
    return handleApiError(error);
  }
}
