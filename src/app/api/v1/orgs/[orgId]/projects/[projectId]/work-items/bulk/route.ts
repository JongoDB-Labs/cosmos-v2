import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { createNotification } from "@/lib/notifications/create";
import { z } from "zod";
import { Priority } from "@prisma/client";

const bulkUpdateSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
  update: z.object({
    columnKey: z.string().nullish(),
    assigneeId: z.string().uuid().nullable().optional(),
    priority: z.nativeEnum(Priority).optional(),
    cycleId: z.string().uuid().nullable().optional(),
    tags: z.array(z.string()).optional(),
  }),
});

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_BULK_EDIT);

    const body = await request.json();
    const { ids, update } = bulkUpdateSchema.parse(body);

    const updateData: Record<string, unknown> = {};
    if (update.columnKey !== undefined) {
      updateData.columnKey = update.columnKey;
      updateData.columnEnteredAt = new Date();
    }
    if (update.assigneeId !== undefined) updateData.assigneeId = update.assigneeId;
    if (update.priority !== undefined) updateData.priority = update.priority;
    if (update.cycleId !== undefined) updateData.cycleId = update.cycleId;
    if (update.tags !== undefined) updateData.tags = update.tags;

    // Snapshot previous state so we can fan out per-item assignee-change
    // notifications after the bulk update succeeds.
    const previousItems = await prisma.workItem.findMany({
      where: { id: { in: ids }, orgId, projectId },
      select: {
        id: true,
        title: true,
        assigneeId: true,
        projectId: true,
      },
    });
    const projectKey = await prisma.project
      .findUnique({ where: { id: projectId }, select: { key: true } })
      .then((p) => p?.key ?? projectId)
      .catch(() => projectId);

    const result = await prisma.workItem.updateMany({
      where: { id: { in: ids }, orgId, projectId },
      data: updateData,
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "work_item.bulk_updated",
      entity: "work_item",
      metadata: {
        count: String(result.count),
        fields: Object.keys(update).join(", "),
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    // Notification fan-out for assignee changes
    if (
      update.assigneeId !== undefined &&
      update.assigneeId !== null &&
      update.assigneeId !== ctx.userId
    ) {
      const newAssignee = update.assigneeId;
      for (const prev of previousItems) {
        if (prev.assigneeId === newAssignee) continue;
        await createNotification({
          orgId,
          userId: newAssignee,
          type: "work_item.assigned",
          title: `Assigned: ${prev.title}`,
          message: `You've been assigned a work item`,
          relatedId: prev.id,
          relatedType: "work_item",
          url: `/${org.slug}/projects/${projectKey}/work-items/${prev.id}`,
        }).catch(() => {
          /* swallow */
        });
      }
    }

    return success({ updated: result.count });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_DELETE);

    const body = await request.json();
    const { ids } = bulkDeleteSchema.parse(body);

    const result = await prisma.workItem.deleteMany({
      where: { id: { in: ids }, orgId, projectId },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "work_item.bulk_deleted",
      entity: "work_item",
      metadata: { count: String(result.count) } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
