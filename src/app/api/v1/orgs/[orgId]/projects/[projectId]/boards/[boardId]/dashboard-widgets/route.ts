import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { canManageProject } from "@/lib/rbac/scope";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

const createWidgetSchema = z.object({
  type: z.string().min(1).max(60),
  config: z.record(z.string(), z.unknown()).optional(),
  position: z.record(z.string(), z.unknown()).optional(),
});

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; boardId: string }>;
};

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, boardId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.BOARD_READ);

    const board = await prisma.board.findFirst({
      where: { id: boardId, projectId, orgId },
    });
    if (!board) return new Response("Not found", { status: 404 });

    const widgets = await prisma.dashboardWidget.findMany({
      where: { boardId },
      orderBy: { id: "asc" },
    });

    return success(widgets);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, boardId } = await params;
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

    const body = await request.json();
    const data = createWidgetSchema.parse(body);

    const widget = await prisma.dashboardWidget.create({
      data: {
        boardId,
        type: data.type,
        config: (data.config ?? {}) as Prisma.InputJsonValue,
        position: (data.position ?? {}) as Prisma.InputJsonValue,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "dashboard_widget.created",
      entity: "dashboard_widget",
      entityId: widget.id,
      metadata: { type: data.type, boardId } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(widget);
  } catch (error) {
    return handleApiError(error);
  }
}
