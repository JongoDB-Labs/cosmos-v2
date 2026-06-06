import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { BoardType, Prisma } from "@prisma/client";

const updateBoardSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: z.nativeEnum(BoardType).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  sortOrder: z.number().int().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; projectId: string; boardId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, boardId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.BOARD_READ);

    const board = await prisma.board.findFirst({
      where: { id: boardId, projectId, orgId },
      include: {
        columns: { orderBy: { sortOrder: "asc" } },
      },
    });

    if (!board) return new Response("Not found", { status: 404 });

    return success(board);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, boardId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.BOARD_UPDATE);

    const existing = await prisma.board.findFirst({ where: { id: boardId, projectId, orgId } });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateBoardSchema.parse(body);

    const updated = await prisma.board.update({
      where: { id: boardId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.type !== undefined && { type: data.type }),
        ...(data.config !== undefined && { config: data.config as Prisma.InputJsonValue }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
      },
      include: { columns: { orderBy: { sortOrder: "asc" } } },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "board.updated",
      entity: "board",
      entityId: boardId,
      metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, boardId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.BOARD_DELETE);

    const existing = await prisma.board.findFirst({ where: { id: boardId, projectId, orgId } });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.board.delete({ where: { id: boardId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "board.deleted",
      entity: "board",
      entityId: boardId,
      metadata: { name: existing.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
