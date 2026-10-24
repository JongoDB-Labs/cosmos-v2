import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { orgContext } from "@/lib/openapi/org-context";
import type { AuthContext } from "@/lib/rbac/check";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { STATUS_BOARD_TYPES, setStatusCategory, toStatusDto } from "@/lib/workflow/statuses.server";
import { deleteStatus, updateStatus } from "./route.contract";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; key: string }> };

/** Resolve the status, and check the actor may manage the project's statuses. */
async function authorize(request: NextRequest, ctx: AuthContext, p: { orgId: string; projectId: string; key: string }) {
  const project = await prisma.project.findFirst({ where: { id: p.projectId, orgId: p.orgId }, select: { id: true } });
  if (!project) return { ok: false as const, error: problem(404, "not_found", "Project not found", { request }) };
  // The same authority as editing a board's columns: org-wide board update, or project manager.
  await requireProjectManage(ctx, p.projectId, Permission.BOARD_UPDATE);
  const status = await prisma.workflowStatus.findUnique({
    where: { projectId_key: { projectId: p.projectId, key: p.key } },
  });
  if (!status) return { ok: false as const, error: problem(404, "not_found", "Status not found", { request }) };
  return { ok: true as const, ctx, status };
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    // Authenticate (and hold a key to the contract's scopes) before validating.
    const { ctx } = await orgContext((await params).orgId, updateStatus);
    const { params: p, body } = await parseRequest(updateStatus, request, params);
    await requireProjectVisible(ctx, p.projectId);
    const auth = await authorize(request, ctx, p);
    if (!auth.ok) return auth.error;

    const row = await prisma.$transaction(async (tx) => {
      // The board columns showing the status keep their (deprecated) mirror
      // of its category in step. Archived stays archived: this is an edit.
      if (body.category && body.category !== auth.status.category) {
        await setStatusCategory(tx, p.projectId, p.key, body.category);
      }
      return tx.workflowStatus.update({
        where: { id: auth.status.id },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.color !== undefined && { color: body.color }),
          ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
          ...(body.archived !== undefined && { archivedAt: body.archived ? (auth.status.archivedAt ?? new Date()) : null }),
        },
      });
    });

    await logAudit({
      orgId: p.orgId,
      userId: auth.ctx.userId,
      action: "workflow.status_updated",
      entity: "workflow_status",
      entityId: row.id,
      metadata: {
        projectId: p.projectId,
        key: row.key,
        changes: Object.keys(body).join(", "),
        ...(body.category && body.category !== auth.status.category
          ? { categoryFrom: auth.status.category, categoryTo: body.category }
          : {}),
      },
      ipAddress: getIpAddress(request),
    });
    return respond(updateStatus, 200, toStatusDto(row));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, deleteStatus);
    const { params: p } = await parseRequest(deleteStatus, request, params);
    await requireProjectVisible(ctx, p.projectId);
    const auth = await authorize(request, ctx, p);
    if (!auth.ok) return auth.error;

    const items = await prisma.workItem.count({ where: { projectId: p.projectId, columnKey: p.key } });
    if (items > 0) {
      return problem(
        409,
        "conflict",
        `${items} item${items === 1 ? " is" : "s are"} in this status. Move ${items === 1 ? "it" : "them"} first, or archive the status.`,
        { request },
      );
    }

    await prisma.$transaction(async (tx) => {
      // The columns showing it go with it; a column must name a status.
      await tx.boardColumn.deleteMany({
        where: { key: p.key, board: { projectId: p.projectId, type: { in: STATUS_BOARD_TYPES } } },
      });
      // RESTRICT from work_items still guards a move into it racing this delete.
      await tx.workflowStatus.delete({ where: { id: auth.status.id } });
    });

    await logAudit({
      orgId: p.orgId,
      userId: auth.ctx.userId,
      action: "workflow.status_deleted",
      entity: "workflow_status",
      entityId: auth.status.id,
      metadata: { projectId: p.projectId, key: p.key },
      ipAddress: getIpAddress(request),
    });
    return respond(deleteStatus, 204, undefined);
  } catch (error) {
    return handleApiError(error);
  }
}
