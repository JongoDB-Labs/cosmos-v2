import { NextRequest } from "next/server";
import { withStatusCategories } from "@/lib/workflow/column-categories.server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectRead, requireProjectVisible } from "@/lib/rbac/require-project-read";
import { narrowBoards } from "@/lib/rbac/board-access";

import { canManageBoardsInProject } from "@/lib/rbac/project-role";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { uniqueBoardSlug } from "@/lib/templates/slugify";
import { z } from "zod";
import { BoardType, Prisma } from "@prisma/client";
import { BOARD_TYPE_REGISTRY } from "@/lib/boards/board-types";
import { DEFAULT_COLUMNS } from "@/lib/boards/default-columns";
import { seedBoardColumns, type ColumnSpec } from "@/lib/workflow/provision.server";

const createBoardSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.nativeEnum(BoardType).default(BoardType.KANBAN),
  config: z.record(z.string(), z.unknown()).optional(),
});

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

/**
 * Delivery boards that start with the project's workflow as their columns
 * (COSMOS-231). Their columns come from seedBoardColumns, never also from the
 * registry's defaultColumns, so a type can't get both.
 */
const SEEDED_FROM_PROJECT = new Set<BoardType>([BoardType.KANBAN, BoardType.SCRUM]);

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
    return success(await withStatusCategories(prisma, projectId, await narrowBoards(ctx, projectId, boards)));
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
    await requireProjectVisible(ctx, projectId);
    await requireProjectVisible(ctx, projectId);
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

    const slug = await uniqueBoardSlug(data.name, projectId);
    const seeded = SEEDED_FROM_PROJECT.has(data.type);
    const board = await prisma.$transaction(async (tx) => {
      const row = await tx.board.create({
        data: {
          orgId,
          projectId,
          name: data.name,
          slug,
          type: data.type,
          config: (data.config ?? {}) as Prisma.InputJsonValue,
          sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
          // Types whose columns ARE their structure get them at creation. A retro
          // board with no columns opens with nowhere to put a note, which reads
          // as a broken feature rather than an unconfigured one.
          columns: {
            create: (seeded ? [] : (BOARD_TYPE_REGISTRY[data.type].defaultColumns ?? [])).map(
              (c, i) => ({ ...c, sortOrder: i })
            ),
          },
        },
      });
      // A new Kanban or Scrum board (Issues' "Save as board", the gallery)
      // shows the project's workflow: the main Kanban board's columns, or the
      // default ones. Through the status provisioning path, so every column
      // is a view onto a status that exists.
      if (seeded) {
        await seedBoardColumns(tx, row, await kanbanColumnsFor(tx, projectId));
      }
      return tx.board.findUniqueOrThrow({
        where: { id: row.id },
        include: { columns: { orderBy: { sortOrder: "asc" } } },
      });
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

/** The columns a new Kanban board starts with: the project's first Kanban board's, else the defaults. */
async function kanbanColumnsFor(tx: Prisma.TransactionClient, projectId: string): Promise<ColumnSpec[]> {
  const primary = await tx.board.findFirst({
    where: { projectId, type: BoardType.KANBAN, columns: { some: {} } },
    orderBy: { sortOrder: "asc" },
    select: { columns: { orderBy: { sortOrder: "asc" }, select: { name: true, key: true, color: true, category: true } } },
  });
  const columns = primary?.columns ?? DEFAULT_COLUMNS;
  return columns.map((c, i) => ({ name: c.name, key: c.key, color: c.color, category: c.category, sortOrder: i }));
}
