import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { isDoneColumnKey } from "@/lib/cycles/sprint-review";
import { z } from "zod";

const completeSchema = z.object({
  moveIncompleteToCycleId: z.string().uuid().nullable().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; projectId: string; cycleId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, cycleId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SPRINT_COMPLETE);

    const cycle = await prisma.cycle.findFirst({
      where: { id: cycleId, projectId, orgId },
      include: { workItems: true },
    });

    if (!cycle) return new Response("Not found", { status: 404 });

    if (cycle.status !== "ACTIVE") {
      return new Response(
        JSON.stringify({ error: "Only active cycles can be completed" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await request.json().catch(() => ({}));
    const data = completeSchema.parse(body);

    const completed = await prisma.$transaction(async (tx) => {
      const items = cycle.workItems;
      const doneItems = items.filter((i) => isDoneColumnKey(i.columnKey));
      const incompleteItems = items.filter((i) => !isDoneColumnKey(i.columnKey));

      const totalPoints = items.reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);
      const completedPoints = doneItems.reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);

      const report = {
        completedAt: new Date().toISOString(),
        totalItems: items.length,
        completedItems: doneItems.length,
        incompleteItems: incompleteItems.length,
        totalStoryPoints: totalPoints,
        completedStoryPoints: completedPoints,
        velocity: completedPoints,
        itemsByPriority: items.reduce((acc, i) => {
          acc[i.priority] = (acc[i.priority] ?? 0) + 1;
          return acc;
        }, {} as Record<string, number>),
      };

      if (incompleteItems.length > 0 && data.moveIncompleteToCycleId) {
        await tx.workItem.updateMany({
          where: { id: { in: incompleteItems.map((i) => i.id) } },
          data: { cycleId: data.moveIncompleteToCycleId },
        });
      } else if (incompleteItems.length > 0) {
        await tx.workItem.updateMany({
          where: { id: { in: incompleteItems.map((i) => i.id) } },
          data: { cycleId: null },
        });
      }

      return tx.cycle.update({
        where: { id: cycleId },
        data: { status: "COMPLETED", report },
        include: { _count: { select: { workItems: true } } },
      });
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "cycle.completed",
      entity: "cycle",
      entityId: cycleId,
      metadata: {
        name: cycle.name,
        number: String(cycle.number),
        totalItems: String(cycle.workItems.length),
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(completed);
  } catch (error) {
    return handleApiError(error);
  }
}
