import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { canManageProject } from "@/lib/rbac/scope";
import { requireBoardRead } from "@/lib/rbac/board-access";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { ColumnCategory } from "@prisma/client";
import { boardShowsStatuses, ensureStatuses, renameStatusIfUnshared } from "@/lib/workflow/statuses.server";

const columnSchema = z.object({
  id: z.string().uuid().nullish(),
  name: z.string().min(1).max(50),
  key: z.string().min(1).max(30),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  wipLimit: z.number().int().min(0).nullable().optional(),
  sortOrder: z.number().int(),
  category: z.nativeEnum(ColumnCategory).optional(),
});

const reorderSchema = z.object({
  columns: z.array(columnSchema),
});

type RouteParams = { params: Promise<{ orgId: string; projectId: string; boardId: string }> };

export async function PUT(request: NextRequest, { params }: RouteParams) {
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

    const board = await prisma.board.findFirst({ where: { id: boardId, projectId, orgId } });
    // Team axis: a board you may not open is a board whose columns you may not
    // read or restructure. Same NotFound for hidden as for missing.
    await requireBoardRead(ctx, projectId, board);

    const body = await request.json();
    const { columns } = reorderSchema.parse(body);

    const result = await prisma.$transaction(async (tx) => {
      const existingColumns = await tx.boardColumn.findMany({
        where: { boardId },
        select: { id: true, key: true, category: true },
      });
      const existingIds = existingColumns.map((c) => c.id);

      // A delivery board's columns are views onto the project's statuses, so
      // every column must name one. A key edited on an existing column renames
      // its status when no other board still shows the old key, so the items
      // follow instead of being left on a key nothing shows; then each column's
      // status is made sure of, and a category set here is the status's
      // category (the column keeps a mirror of it). Deleting a column only
      // removes the view: its status and items stay. Ceremony boards are
      // prompts, not statuses, and are left out of all of this.
      if (board && boardShowsStatuses(board.type)) {
        for (const col of columns) {
          const before = existingColumns.find((c) => c.id === col.id);
          if (before && before.key !== col.key) {
            await renameStatusIfUnshared(tx, { projectId, from: before.key, to: col.key, columnId: before.id });
          }
        }
        await ensureStatuses(
          tx,
          { orgId, projectId },
          columns.map((c) => {
            const before = existingColumns.find((e) => e.id === c.id);
            // A save sends every column. Only a column that starts showing a
            // status here (new, or re-keyed) may restore it from the archive;
            // only a category this request changes is written, so a column
            // sent back as it was, or without a category, leaves its status
            // alone.
            const shows = !before || before.key !== c.key;
            const categoryChanged = c.category !== undefined && (shows || c.category !== before?.category);
            return {
              key: c.key,
              name: c.name,
              color: c.color,
              category: categoryChanged ? c.category : undefined,
              sortOrder: c.sortOrder,
              restore: shows,
            };
          }),
          { writeCategory: true },
        );
      }

      const incomingIds = columns.filter((c) => c.id).map((c) => c.id!);
      const toDelete = existingIds.filter((id) => !incomingIds.includes(id));

      if (toDelete.length > 0) {
        await tx.boardColumn.deleteMany({ where: { id: { in: toDelete } } });
      }

      for (const col of columns) {
        if (col.id && existingIds.includes(col.id)) {
          await tx.boardColumn.update({
            where: { id: col.id },
            data: {
              name: col.name,
              key: col.key,
              color: col.color ?? undefined,
              wipLimit: col.wipLimit ?? null,
              sortOrder: col.sortOrder,
              category: col.category,
            },
          });
        } else {
          await tx.boardColumn.create({
            data: {
              boardId,
              name: col.name,
              key: col.key,
              color: col.color ?? "#7dd3fc",
              wipLimit: col.wipLimit ?? null,
              sortOrder: col.sortOrder,
              category: col.category ?? "TODO",
            },
          });
        }
      }

      // Each column mirrors its status's category (deprecated, kept in step for
      // the readers not yet moved to statuses).
      if (board && boardShowsStatuses(board.type)) {
        await tx.$executeRaw`
          UPDATE board_columns bc SET category = s.category
          FROM workflow_statuses s
          WHERE bc.board_id = ${boardId}::uuid AND s.project_id = ${projectId}::uuid
            AND s.key = bc.key AND bc.category <> s.category
        `;
      }

      return tx.boardColumn.findMany({
        where: { boardId },
        orderBy: { sortOrder: "asc" },
      });
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "board.columns_updated",
      entity: "board",
      entityId: boardId,
      metadata: { columnCount: String(columns.length) } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(result);
  } catch (error) {
    return handleApiError(error);
  }
}
