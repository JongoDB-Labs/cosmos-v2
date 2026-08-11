import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import { BoardType } from "@prisma/client";
import {
  allocateTicketNumber,
  allocateSortOrder,
} from "@/lib/work-items/allocate";
import {
  requireContributor,
  isResponse,
  publishCeremonyChanged,
} from "../../../_helpers";

type RouteParams = {
  params: Promise<{
    orgId: string;
    projectId: string;
    intervalId: string;
    actionId: string;
  }>;
};

/**
 * Promote a retro action into real, tracked work.
 *
 * Retro actions that never enter the backlog are the ones that quietly die, so
 * this is one click: the action's text becomes a work item in the project's
 * first To-Do column, carrying its owner and due date, landing on the sprint
 * that follows this one so it shows up in the next planning session.
 *
 * Idempotent by design. Re-promoting returns the work item already created
 * rather than a second copy — a double-click during a live ceremony must not
 * put two identical stories in the backlog.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId, actionId } = await params;
    const loaded = await requireContributor(orgId, projectId, intervalId);
    if (isResponse(loaded)) return loaded;
    const { ctx } = loaded;

    // Creating work is a different authority from contributing to a retro.
    await requireProjectManage(ctx, projectId, Permission.ITEM_CREATE);

    const action = await prisma.retroActionItem.findFirst({
      where: {
        id: actionId,
        ceremony: {
          orgId,
          intervalId,
          board: { projectId },
        },
      },
      select: {
        id: true,
        text: true,
        ownerId: true,
        dueDate: true,
        workItemId: true,
        ceremonyId: true,
        ceremony: { select: { boardId: true } },
      },
    });
    if (!action) return new Response("Action item not found", { status: 404 });

    // Already promoted: hand back what exists. Only if it still exists — the
    // work item may have been deleted since, which nulls the link.
    if (action.workItemId) {
      const existing = await prisma.workItem.findUnique({
        where: { id: action.workItemId },
        select: { id: true, ticketNumber: true, title: true },
      });
      if (existing) return success({ workItem: existing, created: false });
    }

    // Land it on a DELIVERY board, never on the ceremony board that produced it.
    // A retro board's columns are Start / Stop / Continue, so taking "the first
    // TODO column of this board" would file real tracked work under "Start",
    // where no one tracking work would ever look for it.
    const deliveryBoard = await prisma.board.findFirst({
      where: {
        projectId,
        type: { notIn: [BoardType.SPRINT_REVIEW, BoardType.SPRINT_PLANNING] },
        columns: { some: {} },
      },
      orderBy: { sortOrder: "asc" },
      select: {
        columns: {
          orderBy: { sortOrder: "asc" },
          select: { key: true, category: true },
        },
      },
    });

    // Fall back to the ceremony board only when the project has no delivery
    // board at all — a home that reads oddly still beats refusing the promotion
    // and losing the team's decision.
    const columns =
      deliveryBoard?.columns ??
      (await prisma.boardColumn.findMany({
        where: { boardId: action.ceremony.boardId },
        orderBy: { sortOrder: "asc" },
        select: { key: true, category: true },
      }));
    const target =
      columns.find((c) => c.category === "TODO") ?? columns[0] ?? null;
    if (!target) {
      return new Response(
        JSON.stringify({
          error: "This board has no columns, so there is nowhere to put the work.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    // The sprint that follows this one, if the team has created it. Null is
    // fine — the item lands in the backlog instead of a sprint that is not real.
    const thisInterval = await prisma.interval.findUnique({
      where: { id: intervalId },
      select: { number: true },
    });
    const nextInterval = thisInterval
      ? await prisma.interval.findFirst({
          where: { orgId, projectId, number: { gt: thisInterval.number } },
          orderBy: { number: "asc" },
          select: { id: true },
        })
      : null;

    const workItemType = await prisma.workItemType.findFirst({
      where: { isBuiltIn: true, key: { endsWith: ".task" } },
      select: { id: true },
    });
    if (!workItemType) {
      return new Response(
        JSON.stringify({ error: "No built-in task type is available" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const created = await prisma.$transaction(async (tx) => {
      const ticketNumber = await allocateTicketNumber(tx, { orgId, projectId });
      const sortOrder = await allocateSortOrder(tx, {
        orgId,
        projectId,
        columnKey: target.key,
      });

      const item = await tx.workItem.create({
        data: {
          orgId,
          projectId,
          workItemTypeId: workItemType.id,
          title: action.text.slice(0, 255),
          description: "",
          columnKey: target.key,
          assigneeId: action.ownerId,
          dueDate: action.dueDate,
          intervalId: nextInterval?.id ?? null,
          ticketNumber,
          sortOrder,
          createdById: ctx.userId,
        },
        select: { id: true, ticketNumber: true, title: true },
      });

      await tx.retroActionItem.update({
        where: { id: action.id },
        data: { workItemId: item.id },
      });

      return item;
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "ceremony.action.promote",
      entity: "RetroActionItem",
      entityId: action.id,
      metadata: { workItemId: created.id, intervalId: nextInterval?.id ?? null },
      ipAddress: getIpAddress(request),
    });
    publishCeremonyChanged(orgId, action.ceremonyId);

    return success({ workItem: created, created: true });
  } catch (e) {
    return handleApiError(e);
  }
}
