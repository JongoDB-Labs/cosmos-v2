import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { setWorkItemLabels } from "@/lib/work-items/labels";
import { requireAccess } from "@/lib/abac/require-access";
import { handleApiError, getIpAddress } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { splitWorkItemAssignees } from "./route.contract";
import { logAudit } from "@/lib/audit";
import { publishToOrg } from "@/lib/realtime/broker";
import { storeEmbedding } from "@/lib/rag/embed";
import { allocateTicketNumber } from "@/lib/work-items/allocate";
import { copyFields } from "@/lib/work-items/copy-fields";
import { planSplit } from "@/lib/work-items/split-assignees";
import { createWorkItemRow, updateWorkItems } from "@/lib/work-items/write.server";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; itemId: string }>;
};

/**
 * Split per assignee (COSMOS-89). The original keeps its first assignee; each
 * other assignee gets a copy with the same planning fields (see copyFields)
 * and the same parent, linked to the original as a CLONE so the family stays
 * traceable. Titles are kept as they are: each copy is the same work, owned
 * by someone else, not a "Copy of" to be edited.
 *
 * Needs both ITEM_UPDATE on the original (it loses assignees) and ITEM_CREATE
 * (new items appear).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, splitWorkItemAssignees);
    const { params: { orgId, projectId, itemId } } = await parseRequest(splitWorkItemAssignees, request, params);
    await requireProjectVisible(ctx, projectId);

    const source = await prisma.workItem.findFirst({
      where: { id: itemId, orgId, projectId },
      include: { assignees: { orderBy: { sortOrder: "asc" }, select: { userId: true } } },
    });
    if (!source) return problem(404, "not_found", undefined, { request });

    await requireAccess(ctx, "ITEM_UPDATE", {
      createdById: source.createdById,
      assigneeId: source.assigneeId,
      projectId,
    });
    await requireAccess(ctx, "ITEM_CREATE", {
      createdById: ctx.userId,
      assigneeId: source.assigneeId,
      projectId,
    });

    const plan = planSplit(source.assignees.map((a) => a.userId));
    if (!plan) {
      return problem(400, "invalid_request", "Only an item with two or more assignees can be split", { request });
    }

    const copies = await prisma.$transaction(async (tx) => {
      // The allocator's advisory lock holds until this transaction ends, so the
      // copies can take sequential numbers without another create interleaving.
      let nextTicket = await allocateTicketNumber(tx, { orgId, projectId });
      const maxSort = await tx.workItem.aggregate({
        where: { orgId, projectId, columnKey: source.columnKey },
        _max: { sortOrder: true },
      });
      let nextSort = (maxSort._max.sortOrder ?? -1) + 1;

      // The original keeps only its first assignee.
      await tx.workItemAssignee.deleteMany({
        where: { workItemId: source.id, userId: { in: plan.splitOff } },
      });
      await updateWorkItems(tx, [source.id], { assigneeId: plan.keep }, { actorId: ctx.userId, source: "API" });
      await tx.activity.create({
        data: {
          orgId,
          workItemId: source.id,
          userId: ctx.userId,
          action: "updated",
          field: "assignees",
          oldValue: [plan.keep, ...plan.splitOff].join(","),
          newValue: plan.keep,
        },
      });

      const made = [];
      for (const userId of plan.splitOff) {
        const copy = await createWorkItemRow(tx, {
          data: {
            ...copyFields(source),
            orgId,
            projectId,
            title: source.title,
            assigneeId: userId,
            ticketNumber: nextTicket++,
            sortOrder: nextSort++,
            createdById: ctx.userId,
          },
        }, { actorId: ctx.userId, source: "API" });
        await tx.workItemAssignee.create({ data: { workItemId: copy.id, userId, sortOrder: 0 } });
        if (source.tags.length > 0) await setWorkItemLabels(tx, orgId, copy.id, source.tags, { actorId: ctx.userId, source: "API" });
        await tx.workItemLink.create({
          data: { orgId, sourceItemId: copy.id, targetItemId: source.id, type: "CLONES" },
        });
        await tx.activity.create({
          data: { orgId, workItemId: copy.id, userId: ctx.userId, action: "created" },
        });
        made.push(copy);
      }
      return made;
    });

    for (const copy of copies) {
      await storeEmbedding("work_items", copy.id, `${copy.title}\n${copy.description}`).catch(
        (err: unknown) =>
          console.warn("[rag] failed to persist work item embedding:", (err as Error).message),
      );
      await logAudit({
        orgId,
        userId: ctx.userId,
        action: "work_item.created",
        entity: "work_item",
        entityId: copy.id,
        metadata: {
          title: copy.title,
          ticketNumber: String(copy.ticketNumber),
          splitFrom: String(source.ticketNumber),
        } as Record<string, string>,
        ipAddress: getIpAddress(request),
      });
    }

    try {
      publishToOrg(orgId, "work-item.updated", {
        id: source.id,
        projectId,
        columnKey: source.columnKey,
        ticketNumber: source.ticketNumber,
      });
      for (const copy of copies) {
        publishToOrg(orgId, "work-item.created", {
          id: copy.id,
          projectId,
          title: copy.title,
          workItemTypeId: copy.workItemTypeId,
          columnKey: copy.columnKey,
          ticketNumber: copy.ticketNumber,
        });
      }
    } catch {
      /* never let a broker error break the response */
    }

    return respond(splitWorkItemAssignees, 201, {
      keptAssigneeId: plan.keep,
      copies: copies.map((c) => ({
        id: c.id,
        ticketNumber: c.ticketNumber,
        title: c.title,
        assigneeId: c.assigneeId,
      })),
    });
  } catch (error) {
    return handleApiError(error, request);
  }
}
