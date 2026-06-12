import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireAccess } from "@/lib/abac/require-access";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { createNotification } from "@/lib/notifications/create";
import { publishToOrg } from "@/lib/realtime/broker";
import { storeEmbedding } from "@/lib/rag/embed";
import { z } from "zod";
import { Priority, Prisma } from "@prisma/client";

const updateItemSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullish(),
  workItemTypeId: z.string().uuid().nullish(),
  columnKey: z.string().nullish(),
  assigneeId: z.string().uuid().nullable().optional(),
  priority: z.nativeEnum(Priority).optional(),
  cycleId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  storyPoints: z.number().int().min(0).nullable().optional(),
  sortOrder: z.number().int().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  startDate: z.string().datetime().nullable().optional(),
  tags: z.array(z.string()).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});

type RouteParams = { params: Promise<{ orgId: string; projectId: string; itemId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_READ);

    const item = await prisma.workItem.findFirst({
      where: { id: itemId, orgId, projectId },
      include: {
        parent: { select: { id: true, title: true, ticketNumber: true, workItemTypeId: true } },
        children: { select: { id: true, title: true, columnKey: true, ticketNumber: true, workItemTypeId: true }, orderBy: { sortOrder: "asc" } },
        comments: { orderBy: { createdAt: "asc" }, take: 50 },
        activities: { orderBy: { createdAt: "desc" }, take: 50 },
        workItemType: { select: { id: true, key: true, name: true, icon: true, color: true } },
        cycle: { select: { id: true, name: true, number: true, status: true } },
      },
    });

    if (!item) return new Response("Not found", { status: 404 });

    return success(item);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.workItem.findFirst({ where: { id: itemId, orgId, projectId } });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz: checks ITEM_UPDATE in the bitfield AND applies any
    // work-role/member deny policy that references it (narrowing by ownership /
    // project membership). Identical to requirePermission until a policy exists.
    await requireAccess(ctx, "ITEM_UPDATE", {
      createdById: existing.createdById,
      assigneeId: existing.assigneeId,
      projectId,
    });

    const body = await request.json();
    const data = updateItemSchema.parse(body);

    const item = await prisma.$transaction(async (tx) => {
      const trackFields: Array<{ field: string; oldVal: string | null; newVal: string | null }> = [];

      if (data.title !== undefined && data.title !== existing.title) {
        trackFields.push({ field: "title", oldVal: existing.title, newVal: data.title });
      }
      if (data.columnKey !== undefined && data.columnKey !== existing.columnKey) {
        trackFields.push({ field: "columnKey", oldVal: existing.columnKey, newVal: data.columnKey });
      }
      if (data.priority !== undefined && data.priority !== existing.priority) {
        trackFields.push({ field: "priority", oldVal: existing.priority, newVal: data.priority });
      }
      if (data.assigneeId !== undefined && data.assigneeId !== existing.assigneeId) {
        trackFields.push({ field: "assigneeId", oldVal: existing.assigneeId, newVal: data.assigneeId });
      }
      if (data.cycleId !== undefined && data.cycleId !== existing.cycleId) {
        trackFields.push({ field: "cycleId", oldVal: existing.cycleId, newVal: data.cycleId });
      }
      if (data.workItemTypeId !== undefined && data.workItemTypeId !== existing.workItemTypeId) {
        trackFields.push({ field: "workItemTypeId", oldVal: existing.workItemTypeId, newVal: data.workItemTypeId });
      }

      const columnChanged = data.columnKey !== undefined && data.columnKey !== existing.columnKey;

      const updateData: Record<string, unknown> = {};
      if (data.title !== undefined) updateData.title = data.title;
      if (data.description !== undefined) updateData.description = data.description ?? "";
      if (data.workItemTypeId !== undefined) updateData.workItemTypeId = data.workItemTypeId;
      if (data.columnKey !== undefined && data.columnKey !== null) {
        updateData.columnKey = data.columnKey;
        if (columnChanged) updateData.columnEnteredAt = new Date();
      }
      if (data.assigneeId !== undefined) updateData.assigneeId = data.assigneeId;
      if (data.priority !== undefined) updateData.priority = data.priority;
      if (data.cycleId !== undefined) updateData.cycleId = data.cycleId;
      if (data.parentId !== undefined) updateData.parentId = data.parentId;
      if (data.storyPoints !== undefined) updateData.storyPoints = data.storyPoints;
      if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;
      if (data.dueDate !== undefined) updateData.dueDate = data.dueDate ? new Date(data.dueDate) : null;
      if (data.startDate !== undefined) updateData.startDate = data.startDate ? new Date(data.startDate) : null;
      if (data.tags !== undefined) updateData.tags = data.tags;
      if (data.customFields !== undefined) updateData.customFields = data.customFields as Prisma.InputJsonValue;

      const doneColumn = data.columnKey && ["done", "completed", "closed"].some(
        (k) => data.columnKey!.toLowerCase().includes(k)
      );
      if (doneColumn && !existing.completedAt) {
        updateData.completedAt = new Date();
      } else if (data.columnKey && !doneColumn && existing.completedAt) {
        updateData.completedAt = null;
      }

      const updated = await tx.workItem.update({
        where: { id: itemId },
        data: updateData,
        include: {
          children: { select: { id: true, title: true, columnKey: true, workItemTypeId: true }, orderBy: { sortOrder: "asc" } },
          workItemType: { select: { id: true, key: true, name: true, icon: true, color: true, celebrateOnComplete: true } },
          _count: { select: { comments: true, activities: true } },
        },
      });

      if (trackFields.length > 0) {
        await tx.activity.createMany({
          data: trackFields.map((f) => ({
            orgId,
            workItemId: itemId,
            userId: ctx.userId,
            action: "updated",
            field: f.field,
            oldValue: f.oldVal,
            newValue: f.newVal,
          })),
        });
      }

      return updated;
    });

    // RAG: re-embed when searchable text changed. Same skip-when-untouched
    // optimization as the note route. Runs after the update.
    if (data.title !== undefined || data.description !== undefined) {
      await storeEmbedding("work_items", itemId, `${item.title}\n${item.description}`).catch(
        (err: unknown) =>
          console.warn("[rag] failed to persist work item embedding:", (err as Error).message)
      );
    }

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "work_item.updated",
      entity: "work_item",
      entityId: itemId,
      metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    // Live updates: tell other clients viewing this project's boards/issues to
    // refresh (FR: "issue updates without manual refresh"). Best-effort — the
    // broker error is swallowed so it never breaks the PUT response.
    try {
      publishToOrg(orgId, "work-item.updated", {
        id: itemId,
        projectId,
        columnKey: item.columnKey,
        ticketNumber: item.ticketNumber,
      });
    } catch {
      /* never let a broker error break the update response */
    }

    // Notify the new assignee when assignee changes to a non-null user
    // who isn't the actor themselves. Best-effort — never break the PUT.
    if (
      data.assigneeId !== undefined &&
      data.assigneeId !== null &&
      data.assigneeId !== existing.assigneeId &&
      data.assigneeId !== ctx.userId
    ) {
      const actor = await prisma.user
        .findUnique({ where: { id: ctx.userId }, select: { displayName: true, email: true } })
        .catch(() => null);
      const actorName = actor?.displayName || actor?.email || "Someone";
      const itemLabel = existing.ticketNumber
        ? `#${existing.ticketNumber} ${existing.title}`
        : existing.title;

      await createNotification({
        orgId,
        userId: data.assigneeId,
        type: "work_item.assigned",
        title: `Assigned: ${itemLabel}`,
        message: `${actorName} assigned you a work item`,
        relatedType: "work_item",
        relatedId: itemId,
        url: `/${org.slug}`,
      }).catch(() => {
        /* swallow — notification is convenience, not load-bearing */
      });
    }

    return success(item);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.workItem.findFirst({ where: { id: itemId, orgId, projectId } });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz (ITEM_DELETE + any narrowing deny policy).
    await requireAccess(ctx, "ITEM_DELETE", {
      createdById: existing.createdById,
      assigneeId: existing.assigneeId,
      projectId,
    });

    await prisma.workItem.delete({ where: { id: itemId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "work_item.deleted",
      entity: "work_item",
      entityId: itemId,
      metadata: { title: existing.title, ticketNumber: String(existing.ticketNumber) } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    try {
      publishToOrg(orgId, "work-item.deleted", {
        id: itemId,
        projectId,
        ticketNumber: existing.ticketNumber,
      });
    } catch {
      /* never let a broker error break the delete response */
    }

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
