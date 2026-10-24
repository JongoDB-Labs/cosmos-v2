import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { publishToOrg } from "@/lib/realtime/broker";
import { MergeError, mergeWorkItems } from "@/lib/work-items/merge.server";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; itemId: string }>;
};

const bodySchema = z.object({ intoId: z.string().uuid() });

/**
 * Merge this item (a duplicate) into `intoId`, which survives (COSMOS-207).
 * See lib/work-items/merge.server for exactly what moves. Both items are
 * edited, so the caller needs ITEM_UPDATE on each, with any deny policy that
 * applies to either; the whole merge is one transaction.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectVisible(ctx, projectId);

    const { intoId } = bodySchema.parse(await request.json());
    const items = await prisma.workItem.findMany({
      where: { id: { in: [itemId, intoId] }, orgId, projectId },
      select: { id: true, createdById: true, assigneeId: true, ticketNumber: true },
    });
    const dup = items.find((i) => i.id === itemId);
    const survivor = items.find((i) => i.id === intoId);
    if (!dup || !survivor) return new Response("Not found", { status: 404 });
    for (const it of [dup, survivor]) {
      await requireAccess(ctx, "ITEM_UPDATE", { createdById: it.createdById, assigneeId: it.assigneeId, projectId });
    }

    let result;
    try {
      result = await prisma.$transaction((tx) =>
        mergeWorkItems(tx, { orgId, projectId, duplicateId: itemId, survivorId: intoId, userId: ctx.userId }),
      );
    } catch (e) {
      if (e instanceof MergeError) return NextResponse.json({ error: e.message }, { status: 400 });
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
    return success({ merged, into, moved: result.moved });
  } catch (error) {
    return handleApiError(error);
  }
}
