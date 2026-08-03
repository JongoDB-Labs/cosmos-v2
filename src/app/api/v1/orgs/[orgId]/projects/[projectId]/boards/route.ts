import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { narrowBoards } from "@/lib/rbac/board-access";

import { canManageBoardsInProject } from "@/lib/rbac/project-role";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { uniqueBoardSlug } from "@/lib/templates/slugify";
import { z } from "zod";
import { BoardType, Prisma } from "@prisma/client";

const createBoardSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.nativeEnum(BoardType).default(BoardType.KANBAN),
  config: z.record(z.string(), z.unknown()).optional(),
});

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectRead(ctx, projectId, "BOARD_READ");

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const boards = await prisma.board.findMany({
      where: { projectId, orgId },
      include: {
        columns: { orderBy: { sortOrder: "asc" } },
        _count: true,
      },
      orderBy: { sortOrder: "asc" },
    });

    // The TEAM axis. `requireProjectRead` above answers "may they open this
    // project"; this answers "which of its boards are theirs to see". Without
    // it this route returned every board while the sidebar hid the ones
    // assigned to another team — the same question, two different answers.
    return success(await narrowBoards(ctx, projectId, boards));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Inheriting authority, now including the PROJECT role: an org-wide
    // BOARD_CREATE holder, or a MANAGER/LEAD of this project. A project VIEWER
    // is refused even holding the org bit — that is what the label promises.
    if (!(await canManageBoardsInProject(ctx, projectId))) {
      return new Response("Forbidden", { status: 403 });
    }

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = createBoardSchema.parse(body);

    // Respect the project's board-type allow-list (settings.disabledBoardTypes).
    const disabledTypes =
      ((project.settings as { disabledBoardTypes?: string[] } | null)?.disabledBoardTypes) ?? [];
    if (disabledTypes.includes(data.type)) {
      return new Response("This board type is disabled for this project", { status: 403 });
    }

    const maxSort = await prisma.board.aggregate({
      where: { projectId },
      _max: { sortOrder: true },
    });

    const board = await prisma.board.create({
      data: {
        orgId,
        projectId,
        name: data.name,
        slug: await uniqueBoardSlug(data.name, projectId),
        type: data.type,
        config: (data.config ?? {}) as Prisma.InputJsonValue,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
      },
      include: { columns: true },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "board.created",
      entity: "board",
      entityId: board.id,
      metadata: { name: data.name, type: data.type } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(board);
  } catch (error) {
    return handleApiError(error);
  }
}
