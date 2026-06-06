import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { ColumnCategory } from "@prisma/client";

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
    requirePermission(ctx, Permission.BOARD_UPDATE);

    const board = await prisma.board.findFirst({ where: { id: boardId, projectId, orgId } });
    if (!board) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const { columns } = reorderSchema.parse(body);

    const result = await prisma.$transaction(async (tx) => {
      const existingIds = (
        await tx.boardColumn.findMany({ where: { boardId }, select: { id: true } })
      ).map((c) => c.id);

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
