import { NextRequest } from "next/server";
import { withStatusCategories } from "@/lib/workflow/column-categories.server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { requireBoardRead } from "@/lib/rbac/board-access";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { canManageProject } from "@/lib/rbac/scope";
import { canManageOwnBoard, OWNER_EDITABLE_BOARD_FIELDS } from "@/lib/rbac/board-ownership";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { widgetLinkProblems } from "@/lib/boards/widget-links";
import { problem } from "@/lib/openapi/problem";
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

    return success((await withStatusCategories(prisma, projectId, [board!]))[0]);
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
    const managesBoards =
      hasPermission(ctx.permissions, Permission.BOARD_UPDATE) ||
      (await canManageProject(ctx, projectId, Permission.BOARD_UPDATE));

    const existing = await prisma.board.findFirst({ where: { id: boardId, projectId, orgId } });

    // …or the person who made this board (`canManageOwnBoard`). Checked only
    // when the manager gate said no, and answered with the SAME 403 the manager
    // gate always gave — whether the board is missing or someone else's — so a
    // member probing ids learns nothing they could not learn before.
    if (!managesBoards) {
      if (!existing || !(await canManageOwnBoard(ctx, projectId, existing))) {
        return new Response("Forbidden", { status: 403 });
      }
      // The owner path stands on the board being THEIRS TO SEE as well: a
      // creator later moved off a restricted project, or off the board's team,
      // must not keep editing through a URL.
      await requireProjectRead(ctx, projectId, "BOARD_READ");
      await requireBoardRead(ctx, projectId, existing);
    }
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateBoardSchema.parse(body);

    // An owner may rename their board and change its layout. Team assignment,
    // type and tab order are project-management acts: they change how the
    // project is organised for everyone, not what this one board shows.
    if (!managesBoards) {
      const beyond = (Object.keys(data) as Array<keyof typeof data>).filter(
        (k) =>
          data[k] !== undefined &&
          !(OWNER_EDITABLE_BOARD_FIELDS as readonly string[]).includes(k),
      );
      if (beyond.length > 0) {
        return new Response(
          JSON.stringify({
            error: `Only a project manager can change a board's ${beyond.join(", ")}.`,
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // The same link rule the Link List draws with, so a direct API write cannot
    // store a link the page would refuse to show (`widget-links.ts`).
    const linkProblems = widgetLinkProblems((data.config as { widgets?: unknown } | undefined)?.widgets);
    if (linkProblems.length > 0) {
      return problem(400, "invalid_request", `A link can't be saved. ${linkProblems.join(" ")}`, {
        request,
      });
    }

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

    return success((await withStatusCategories(prisma, projectId, [updated]))[0]);
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
    // Inheriting authority: org-wide BOARD_DELETE holder OR project MANAGER,
    // or the board's own creator (same reasoning and same 403 as PUT above).
    const managesBoards =
      hasPermission(ctx.permissions, Permission.BOARD_DELETE) ||
      (await canManageProject(ctx, projectId, Permission.BOARD_DELETE));

    const existing = await prisma.board.findFirst({ where: { id: boardId, projectId, orgId } });
    if (!managesBoards) {
      if (!existing || !(await canManageOwnBoard(ctx, projectId, existing))) {
        return new Response("Forbidden", { status: 403 });
      }
      await requireProjectRead(ctx, projectId, "BOARD_READ");
      await requireBoardRead(ctx, projectId, existing);
    }
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
