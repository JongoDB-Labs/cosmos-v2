import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { isDoneStatus } from "@/lib/work-items/done-state";
import { loadStatusCategories } from "@/lib/boards/status-categories.server";
import { updateWorkItems } from "@/lib/work-items/write.server";
import { buildIntervalReport } from "@/lib/intervals/interval-report";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";

const completeSchema = z.object({
  moveIncompleteToIntervalId: z.string().uuid().nullable().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; projectId: string; intervalId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectVisible(ctx, projectId);
    await requireProjectManage(ctx, projectId, Permission.SPRINT_COMPLETE);

    const interval = await prisma.interval.findFirst({
      where: { id: intervalId, projectId, orgId },
      include: { workItems: true },
    });

    if (!interval) return new Response("Not found", { status: 404 });

    if (interval.status !== "ACTIVE") {
      return new Response(
        JSON.stringify({ error: "Only active intervals can be completed" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await request.json().catch(() => ({}));
    const data = completeSchema.parse(body);

    const completed = await prisma.$transaction(async (tx) => {
      const items = interval.workItems;
      // Done is the status's CATEGORY, so a team-named done lane counts.
      const statuses = await loadStatusCategories(tx, projectId);
      const incompleteItems = items.filter((i) => !isDoneStatus(i.columnKey, statuses));

      // Built BEFORE the reassignment below, and it records which items carried.
      // Completing the sprint severs their link to it, so after this transaction
      // nothing else can answer "what rolled into the next sprint" — the review
      // board would derive an empty list.
      const report = buildIntervalReport(items, new Date().toISOString(), statuses);

      if (incompleteItems.length > 0) {
        await updateWorkItems(
          tx,
          incompleteItems.map((i) => i.id),
          { intervalId: data.moveIncompleteToIntervalId ?? null },
          { actorId: ctx.userId, source: "API" },
        );
      }

      return tx.interval.update({
        where: { id: intervalId },
        data: {
          status: "COMPLETED",
          report: report as unknown as Prisma.InputJsonValue,
        },
        include: { _count: { select: { workItems: true } } },
      });
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "interval.completed",
      entity: "interval",
      entityId: intervalId,
      metadata: {
        name: interval.name,
        number: String(interval.number),
        totalItems: String(interval.workItems.length),
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(completed);
  } catch (error) {
    return handleApiError(error);
  }
}
