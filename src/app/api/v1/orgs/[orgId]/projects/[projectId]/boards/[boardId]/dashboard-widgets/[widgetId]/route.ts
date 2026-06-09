import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { canManageProject } from "@/lib/rbac/scope";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

const updateWidgetSchema = z.object({
  type: z.string().min(1).max(60).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  position: z.record(z.string(), z.unknown()).optional(),
});

type RouteParams = {
  params: Promise<{
    orgId: string;
    projectId: string;
    boardId: string;
    widgetId: string;
  }>;
};

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, boardId, widgetId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Inheriting authority: org-wide BOARD_UPDATE holder OR project MANAGER.
    if (
      !hasPermission(ctx.permissions, Permission.BOARD_UPDATE) &&
      !(await canManageProject(ctx, projectId))
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    const board = await prisma.board.findFirst({
      where: { id: boardId, projectId, orgId },
    });
    if (!board) return new Response("Not found", { status: 404 });

    const widget = await prisma.dashboardWidget.findFirst({
      where: { id: widgetId, boardId },
    });
    if (!widget) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateWidgetSchema.parse(body);

    const updated = await prisma.dashboardWidget.update({
      where: { id: widgetId },
      data: {
        ...(data.type !== undefined ? { type: data.type } : {}),
        ...(data.config !== undefined
          ? { config: data.config as Prisma.InputJsonValue }
          : {}),
        ...(data.position !== undefined
          ? { position: data.position as Prisma.InputJsonValue }
          : {}),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "dashboard_widget.updated",
      entity: "dashboard_widget",
      entityId: widgetId,
      metadata: { type: updated.type, boardId } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, boardId, widgetId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Inheriting authority: org-wide BOARD_UPDATE holder OR project MANAGER.
    if (
      !hasPermission(ctx.permissions, Permission.BOARD_UPDATE) &&
      !(await canManageProject(ctx, projectId))
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    const board = await prisma.board.findFirst({
      where: { id: boardId, projectId, orgId },
    });
    if (!board) return new Response("Not found", { status: 404 });

    const widget = await prisma.dashboardWidget.findFirst({
      where: { id: widgetId, boardId },
    });
    if (!widget) return new Response("Not found", { status: 404 });

    await prisma.dashboardWidget.delete({ where: { id: widgetId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "dashboard_widget.deleted",
      entity: "dashboard_widget",
      entityId: widgetId,
      metadata: { type: widget.type, boardId } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
