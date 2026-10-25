import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireAccess } from "@/lib/abac/require-access";
import { handleApiError, getIpAddress } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { mergeWorkItem } from "./route.contract";
import { logAudit } from "@/lib/audit";
import { publishToOrg } from "@/lib/realtime/broker";
import { MergeError, mergeWorkItems } from "@/lib/work-items/merge.server";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; itemId: string }>;
};

/**
 * Merge this item (a duplicate) into `intoId`, which survives (COSMOS-207).
 * See lib/work-items/merge.server for exactly what moves. Both items are
 * edited, so the caller needs ITEM_UPDATE on each, with any deny policy that
 * applies to either; the whole merge is one transaction.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, mergeWorkItem);
    const { params: { orgId, projectId, itemId }, body: { intoId } } = await parseRequest(mergeWorkItem, request, params);
    await requireProjectVisible(ctx, projectId);

    const items = await prisma.workItem.findMany({
      where: { id: { in: [itemId, intoId] }, orgId, projectId },
      select: { id: true, createdById: true, assigneeId: true, ticketNumber: true },
    });
    const dup = items.find((i) => i.id === itemId);
    const survivor = items.find((i) => i.id === intoId);
    if (!dup || !survivor) return problem(404, "not_found", undefined, { request });
    for (const it of [dup, survivor]) {
      await requireAccess(ctx, "ITEM_UPDATE", { createdById: it.createdById, assigneeId: it.assigneeId, projectId });
    }

    let result;
    try {
      result = await prisma.$transaction((tx) =>
        mergeWorkItems(tx, { orgId, projectId, duplicateId: itemId, survivorId: intoId, userId: ctx.userId }),
      );
    } catch (e) {
      if (e instanceof MergeError) return problem(400, "invalid_request", e.message, { request });
      throw e;
    }

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "work_item.merged",
      entity: "work_item",
      entityId: itemId,
      metadata: {
        into: intoId,
        ticketNumber: String(dup.ticketNumber),
        intoTicketNumber: String(survivor.ticketNumber),
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    try {
      for (const id of [itemId, intoId]) publishToOrg(orgId, "work-item.updated", { id, projectId });
    } catch {
      /* never let a broker error break the response */
    }

    const [merged, into] = await Promise.all(
      [itemId, intoId].map((id) =>
        prisma.workItem.findUniqueOrThrow({
          where: { id },
          // An internal search index, not part of the item.
          omit: { searchVector: true },
          include: {
            children: { select: { id: true, title: true, columnKey: true, ticketNumber: true, workItemTypeId: true, completedAt: true }, orderBy: { sortOrder: "asc" } },
            workItemType: { select: { id: true, key: true, name: true, icon: true, color: true } },
            assignees: {
              orderBy: { sortOrder: "asc" },
              select: { userId: true, user: { select: { id: true, displayName: true, avatarUrl: true } } },
            },
          },
        }),
      ),
    );
    return respond(mergeWorkItem, 200, { merged, into, moved: result.moved });
  } catch (error) {
    return handleApiError(error, request);
  }
}
