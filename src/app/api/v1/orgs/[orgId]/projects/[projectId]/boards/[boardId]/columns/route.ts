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
import { ConflictError } from "@/lib/rbac/check";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { boardShowsStatuses, ensureStatuses, renameStatusIfUnshared } from "@/lib/workflow/statuses.server";
import { withStatusCategories } from "@/lib/workflow/column-categories.server";

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
      !(await canManageProject(ctx, projectId, Permission.BOARD_UPDATE))
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
      // status is made sure of. Deleting a column only removes the view: its
      // status and items stay. Ceremony boards are prompts, not statuses, and
      // are left out of all of this.
      //
      // A column's category is its status's (design §6.4): it is set on the
      // status, in Settings → Workflows. Here it only names the category of a
      // status the column creates, or brings back from the archive.
      // The keys of the columns that start showing a status in this save.
      const touchedKeys: string[] = [];
      if (board && boardShowsStatuses(board.type)) {
        for (const col of columns) {
          const before = existingColumns.find((c) => c.id === col.id);
          if (before && before.key !== col.key) {
            await renameStatusIfUnshared(tx, { projectId, from: before.key, to: col.key, columnId: before.id });
          }
        }
        const known = new Map(
          (
            await tx.workflowStatus.findMany({
              where: { projectId, key: { in: columns.map((c) => c.key) } },
              select: { key: true, category: true, archivedAt: true },
            })
          ).map((st) => [st.key, st]),
        );
        for (const c of columns) {
          const status = known.get(c.key);
          const before = existingColumns.find((e) => e.id === c.id);
          // Sent back as it was (even where a conflicted board's lane disagrees
          // with its status) is fine; a new category is the workflow editor's.
          if (status && !status.archivedAt && c.category && c.category !== status.category && c.category !== before?.category) {
            throw new ConflictError(`A column's category is its status's: change "${c.key}" in Settings → Workflows.`);
          }
        }
        // A new status in a project on a custom workflow is a workflow change.
        if (columns.some((c) => !known.has(c.key)) && (await tx.workflowAssignment.count({ where: { projectId } })) > 0) {
          await requireProjectManage(ctx, projectId, Permission.WORKFLOW_MANAGE);
        }
        await ensureStatuses(
          tx,
          { orgId, projectId },
          columns.map((c) => {
            const before = existingColumns.find((e) => e.id === c.id);
            // A save sends every column. Only a column that starts showing a
            // status here (new, or re-keyed) may restore it from the archive.
            const shows = !before || before.key !== c.key;
            if (shows) touchedKeys.push(c.key);
            return { key: c.key, name: c.name, color: c.color, category: c.category, sortOrder: c.sortOrder, restore: shows };
          }),
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

      // A column that starts showing a status here stores the status's
      // category, so it is never mistaken for a lane the backfill found
      // conflicting (column-categories.server.ts). Columns sent back as they
      // were keep theirs: a conflicted lane's counts until it is resolved.
      if (board && boardShowsStatuses(board.type) && touchedKeys.length > 0) {
        await tx.$executeRaw`
          UPDATE board_columns bc SET category = s.category
          FROM workflow_statuses s
          WHERE bc.board_id = ${boardId}::uuid AND s.project_id = ${projectId}::uuid
            AND s.key = bc.key AND bc.category <> s.category
            AND bc.key = ANY(${touchedKeys}::text[])
        `;
      }

      const saved = await tx.boardColumn.findMany({ where: { boardId }, orderBy: { sortOrder: "asc" } });
      return board ? (await withStatusCategories(tx, projectId, [{ type: board.type, columns: saved }]))[0].columns : saved;
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
