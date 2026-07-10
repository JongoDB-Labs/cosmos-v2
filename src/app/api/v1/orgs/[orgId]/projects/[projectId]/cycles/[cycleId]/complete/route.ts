import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { computeSprintMetrics, isDoneColumn } from "@/lib/cycles/sprint-metrics";
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
      const incompleteItems = items.filter((i) => !isDoneColumn(i.columnKey));

      // Retrospective metrics — burn rate, pacing, efficiency — computed with the
      // same shared helper the client review dialog previews before finalizing,
      // so what the user reviews matches what we persist.
      const metrics = computeSprintMetrics({
        items,
        startDate: cycle.startDate,
        endDate: cycle.endDate,
      });

      // Preserve any planning snapshot captured when the sprint was started.
      const prevReport =
        cycle.report && typeof cycle.report === "object" && !Array.isArray(cycle.report)
          ? (cycle.report as Record<string, unknown>)
          : {};

      const report = {
        ...metrics,
        completedAt: new Date().toISOString(),
        ...(prevReport.plan !== undefined && { plan: prevReport.plan }),
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
