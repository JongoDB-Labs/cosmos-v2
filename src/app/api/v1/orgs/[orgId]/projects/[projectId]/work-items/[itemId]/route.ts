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
import { teamsNotify, escapeHtmlBasic } from "@/lib/integrations/teams-notify";
import { storeEmbedding } from "@/lib/rag/embed";
import { syncFeedbackForWorkItems } from "@/lib/feedback/status-sync";
import { z } from "zod";
import { Priority, Prisma, WorkCategory } from "@prisma/client";

const updateItemSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullish(),
  workItemTypeId: z.string().uuid().nullish(),
  columnKey: z.string().nullish(),
  assigneeId: z.string().uuid().nullable().optional(),
  // Multi-assign (FR 1d38496a): replaces the WHOLE set; first entry becomes the
  // primary assigneeId. When present it wins over the legacy single field.
  assigneeIds: z.array(z.string().uuid()).max(50).optional(),
  priority: z.nativeEnum(Priority).optional(),
  intervalId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  storyPoints: z.number().int().min(0).nullable().optional(),
  sortOrder: z.number().int().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  startDate: z.string().datetime().nullable().optional(),
  actualStart: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
  workCategory: z.nativeEnum(WorkCategory).optional(),
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
        interval: { select: { id: true, name: true, number: true, status: true } },
        assignees: {
          orderBy: { sortOrder: "asc" },
          select: {
            userId: true,
            user: { select: { id: true, displayName: true, avatarUrl: true } },
          },
        },
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
      // Multi-assign: the set's first member becomes the primary — track that
      // change under the same field name the activity feed already renders.
      const primaryFromSet =
        data.assigneeIds !== undefined ? (data.assigneeIds[0] ?? null) : undefined;
      if (primaryFromSet !== undefined && primaryFromSet !== existing.assigneeId) {
        trackFields.push({ field: "assigneeId", oldVal: existing.assigneeId, newVal: primaryFromSet });
      }
      if (data.intervalId !== undefined && data.intervalId !== existing.intervalId) {
        trackFields.push({ field: "intervalId", oldVal: existing.intervalId, newVal: data.intervalId });
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
      if (data.assigneeIds !== undefined) updateData.assigneeId = data.assigneeIds[0] ?? null;
      if (data.priority !== undefined) updateData.priority = data.priority;
      if (data.intervalId !== undefined) updateData.intervalId = data.intervalId;
      if (data.parentId !== undefined) updateData.parentId = data.parentId;
      if (data.storyPoints !== undefined) updateData.storyPoints = data.storyPoints;
      if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;
      if (data.dueDate !== undefined) updateData.dueDate = data.dueDate ? new Date(data.dueDate) : null;
      if (data.startDate !== undefined) updateData.startDate = data.startDate ? new Date(data.startDate) : null;
      if (data.actualStart !== undefined) updateData.actualStart = data.actualStart ? new Date(data.actualStart) : null;
      if (data.completedAt !== undefined) updateData.completedAt = data.completedAt ? new Date(data.completedAt) : null;
      if (data.workCategory !== undefined) updateData.workCategory = data.workCategory;
      if (data.tags !== undefined) updateData.tags = data.tags;
      if (data.customFields !== undefined) {
        // MERGE partial custom-field updates into the existing JSON so a PUT
        // that touches one field (the detail sheet's per-field save) never
        // clobbers the item's other custom-field values. Keys explicitly set to
        // null/undefined still overwrite — that's how the UI clears a value.
        const existingCustom =
          existing.customFields && typeof existing.customFields === "object" && !Array.isArray(existing.customFields)
            ? (existing.customFields as Record<string, unknown>)
            : {};
        updateData.customFields = {
          ...existingCustom,
          ...data.customFields,
        } as Prisma.InputJsonValue;
      }

      const doneColumn = data.columnKey && ["done", "completed", "closed"].some(
        (k) => data.columnKey!.toLowerCase().includes(k)
      );
      // Actual End auto-capture (skipped when the request sets completedAt manually).
      if (data.completedAt === undefined) {
        if (doneColumn && !existing.completedAt) {
          updateData.completedAt = new Date();
        } else if (data.columnKey && !doneColumn && existing.completedAt) {
          updateData.completedAt = null;
        }
      }
      // Actual Start auto-capture: first time the item enters a started (in-progress
      // or done) column. Mirrors the completedAt capture; never overwritten once set;
      // a manual actualStart in this request wins.
      const startedColumn =
        data.columnKey != null &&
        !["backlog", "todo", "to-do"].includes(data.columnKey.toLowerCase());
      if (data.actualStart === undefined && startedColumn && !existing.actualStart) {
        updateData.actualStart = new Date();
      }

      // Sync the assignee SET before the row update reads it back:
      // - assigneeIds present → the set is replaced wholesale (order = payload).
      // - legacy single assigneeId → promote it into the set as the new front
      //   (extras are preserved); null clears the whole set — "Unassigned"
      //   from any surface means nobody.
      if (data.assigneeIds !== undefined) {
        await tx.workItemAssignee.deleteMany({ where: { workItemId: itemId } });
        if (data.assigneeIds.length > 0) {
          await tx.workItemAssignee.createMany({
            data: data.assigneeIds.map((userId, i) => ({
              workItemId: itemId,
              userId,
              sortOrder: i,
            })),
            skipDuplicates: true,
          });
        }
      } else if (data.assigneeId !== undefined) {
        if (data.assigneeId === null) {
          await tx.workItemAssignee.deleteMany({ where: { workItemId: itemId } });
        } else {
          await tx.workItemAssignee.upsert({
            where: { workItemId_userId: { workItemId: itemId, userId: data.assigneeId } },
            create: { workItemId: itemId, userId: data.assigneeId, sortOrder: -1 },
            update: { sortOrder: -1 },
          });
        }
      }

      const updated = await tx.workItem.update({
        where: { id: itemId },
        data: updateData,
        include: {
          // Keep the child-ref shape consistent with the GET routes (the detail
          // sheet renders `#{ticketNumber}` for each sub-item) so a PUT echo of a
          // parent doesn't strip ticket numbers off its cached sub-item list.
          children: { select: { id: true, title: true, columnKey: true, ticketNumber: true, workItemTypeId: true }, orderBy: { sortOrder: "asc" } },
          workItemType: { select: { id: true, key: true, name: true, icon: true, color: true, celebrateOnComplete: true } },
          assignees: {
            orderBy: { sortOrder: "asc" },
            select: {
              userId: true,
              user: { select: { id: true, displayName: true, avatarUrl: true } },
            },
          },
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

    // Reflect a column move onto any feedback item this work item was delivered
    // from (PLANNED → IN_PROGRESS → DONE follow the board). Best-effort inside.
    if (data.columnKey !== undefined && data.columnKey !== existing.columnKey) {
      await syncFeedbackForWorkItems([itemId]);
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

    // Teams notification (FR 8a162fe7): item newly COMPLETED (moved into a done
    // column without a prior completedAt). Gated + best-effort inside teamsNotify.
    if (item.completedAt && !existing.completedAt) {
      void (async () => {
        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { key: true },
        });
        await teamsNotify(
          orgId,
          "itemCompleted",
          `✅ <b>${project?.key ?? ""}-${item.ticketNumber}</b> ${escapeHtmlBasic(item.title)} completed`,
        );
      })().catch(() => {});
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
