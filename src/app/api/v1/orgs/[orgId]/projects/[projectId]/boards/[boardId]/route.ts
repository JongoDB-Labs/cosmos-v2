import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { requireBoardRead } from "@/lib/rbac/board-access";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { canManageProject } from "@/lib/rbac/scope";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { BoardType, Prisma } from "@prisma/client";

const updateBoardSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: z.nativeEnum(BoardType).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  sortOrder: z.number().int().optional(),
  // Which team owns this board; null shares it with the whole project. Nullable
  // rather than optional-undefined so "share it again" is expressible — the
  // undefined case means "leave as-is", which is a different instruction.
  teamId: z.string().uuid().nullable().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; projectId: string; boardId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, boardId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectRead(ctx, projectId, "BOARD_READ");

    const board = await prisma.board.findFirst({
      where: { id: boardId, projectId, orgId },
      include: {
        columns: { orderBy: { sortOrder: "asc" } },
      },
    });

    // Throws NotFoundError for a board on another team as well as for one that
    // does not exist — deliberately the same answer. This is the URL-browsing
    // surface: a 403 here would confirm the board exists, which is the one fact
    // team scoping is meant to withhold.
    await requireBoardRead(ctx, projectId, board);

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
    // Inheriting authority: org-wide BOARD_UPDATE holder OR a MANAGER of the
    // project that owns this board (a project-admin runs their own boards).
    if (
      !hasPermission(ctx.permissions, Permission.BOARD_UPDATE) &&
      !(await canManageProject(ctx, projectId))
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    const existing = await prisma.board.findFirst({ where: { id: boardId, projectId, orgId } });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateBoardSchema.parse(body);

    // A team id from another project would otherwise be accepted and make the
    // board invisible to everyone on THIS one — the FK only proves the team
    // exists, not that it is relevant here.
    if (data.teamId) {
      const team = await prisma.team.findFirst({
        where: { id: data.teamId, projectId },
        select: { id: true },
      });
      if (!team) {
        return new Response(
          JSON.stringify({ error: "That team is not part of this project." }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    const updated = await prisma.board.update({
      where: { id: boardId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.type !== undefined && { type: data.type }),
        ...(data.config !== undefined && { config: data.config as Prisma.InputJsonValue }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
        ...(data.teamId !== undefined && { teamId: data.teamId }),
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
    // Inheriting authority: org-wide BOARD_DELETE holder OR project MANAGER.
    if (
      !hasPermission(ctx.permissions, Permission.BOARD_DELETE) &&
      !(await canManageProject(ctx, projectId))
    ) {
      return new Response("Forbidden", { status: 403 });
    }

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
