import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { publishToOrg } from "@/lib/realtime/broker";
import { storeEmbedding } from "@/lib/rag/embed";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; itemId: string }>;
};

/**
 * Clone an existing work item (FR: "duplicate existing issue"). Copies the
 * source's editable fields into a new row in the SAME column, with a fresh
 * ticket number + sort order. Title is prefixed "Copy of " so the duplicate is
 * obvious and immediately editable. Comments/activity/children are intentionally
 * NOT copied — a duplicate is a fresh ticket seeded from another, not a deep
 * clone. `parentId` IS carried so a duplicated sub-item stays under its parent.
 * Gated on ITEM_CREATE (you're creating a new item), mirroring the create route.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const source = await prisma.workItem.findFirst({
      where: { id: itemId, orgId, projectId },
    });
    if (!source) return new Response("Not found", { status: 404 });

    // The actor becomes the creator of the new item — same authz model as POST
    // /work-items (ITEM_CREATE + any in-project deny policy).
    await requireAccess(ctx, "ITEM_CREATE", {
      createdById: ctx.userId,
      assigneeId: source.assigneeId,
      projectId,
    });

    const item = await prisma.$transaction(async (tx) => {
      const maxTicket = await tx.workItem.aggregate({
        where: { orgId, projectId },
        _max: { ticketNumber: true },
      });
      const ticketNumber = (maxTicket._max.ticketNumber ?? 0) + 1;

      const maxSort = await tx.workItem.aggregate({
        where: { orgId, projectId, columnKey: source.columnKey },
        _max: { sortOrder: true },
      });
      const sortOrder = (maxSort._max.sortOrder ?? -1) + 1;

      const dupe = await tx.workItem.create({
        data: {
          orgId,
          projectId,
          workItemTypeId: source.workItemTypeId,
          title: `Copy of ${source.title}`,
          description: source.description,
          columnKey: source.columnKey,
          assigneeId: source.assigneeId,
          priority: source.priority,
          cycleId: source.cycleId,
          parentId: source.parentId,
          ticketNumber,
          storyPoints: source.storyPoints,
          sortOrder,
          dueDate: source.dueDate,
          startDate: source.startDate,
          columnEnteredAt: new Date(),
          tags: source.tags,
          customFields: source.customFields ?? undefined,
          createdById: ctx.userId,
        },
        include: {
          children: { select: { id: true, title: true, columnKey: true, workItemTypeId: true } },
          workItemType: { select: { id: true, key: true, name: true, icon: true, color: true } },
          _count: { select: { comments: true, activities: true } },
        },
      });

      await tx.activity.create({
        data: {
          orgId,
          workItemId: dupe.id,
          userId: ctx.userId,
          action: "created",
        },
      });

      return dupe;
    });

    await storeEmbedding(
      "work_items",
      item.id,
      `${item.title}\n${item.description}`,
    ).catch((err: unknown) =>
      console.warn("[rag] failed to persist work item embedding:", (err as Error).message),
    );

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "work_item.created",
      entity: "work_item",
      entityId: item.id,
      metadata: {
        title: item.title,
        ticketNumber: String(item.ticketNumber),
        duplicatedFrom: String(source.ticketNumber),
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    try {
      publishToOrg(orgId, "work-item.created", {
        id: item.id,
        projectId,
        title: item.title,
        workItemTypeId: item.workItemTypeId,
        columnKey: item.columnKey,
        ticketNumber: item.ticketNumber,
      });
    } catch {
      /* never let a broker error break the response */
    }

    return created(item);
  } catch (error) {
    return handleApiError(error);
  }
}
