import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ANALYTICS_READ);

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
    });
    if (!project) return new Response("Not found", { status: 404 });

    const boards = await prisma.board.findMany({
      where: { projectId },
      select: { id: true },
    });
    const boardIds = boards.map((b) => b.id);

    const columns = boardIds.length > 0
      ? await prisma.boardColumn.findMany({
          where: { boardId: { in: boardIds } },
          select: { key: true, category: true },
        })
      : [];

    const columnCategoryMap: Record<string, string> = {};
    for (const col of columns) {
      columnCategoryMap[col.key] = col.category;
    }

    const allItems = await prisma.workItem.findMany({
      where: { orgId, projectId },
      select: {
        workItemTypeId: true,
        priority: true,
        columnKey: true,
        assigneeId: true,
        completedAt: true,
        columnEnteredAt: true,
        createdAt: true,
      },
    });

    const itemsByType: Record<string, number> = {};
    const itemsByPriority: Record<string, number> = {};
    const itemsByStatus: Record<string, number> = {};
    const assigneeCounts: Record<string, number> = {};

    for (const item of allItems) {
      itemsByType[item.workItemTypeId] = (itemsByType[item.workItemTypeId] ?? 0) + 1;
      itemsByPriority[item.priority] = (itemsByPriority[item.priority] ?? 0) + 1;

      const category = columnCategoryMap[item.columnKey] ?? "UNKNOWN";
      itemsByStatus[category] = (itemsByStatus[category] ?? 0) + 1;

      if (item.assigneeId) {
        assigneeCounts[item.assigneeId] =
          (assigneeCounts[item.assigneeId] ?? 0) + 1;
      }
    }

    const topAssignees = Object.entries(assigneeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([assigneeId, count]) => ({ assigneeId, count }));

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const recentCompleted = allItems.filter(
      (i) => i.completedAt && new Date(i.completedAt) >= thirtyDaysAgo
    );

    const completionTrend: { date: string; count: number }[] = [];
    for (let d = 0; d < 30; d++) {
      const dayStart = new Date(thirtyDaysAgo.getTime() + d * 86400000);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      const dateStr = dayStart.toISOString().split("T")[0];
      const count = recentCompleted.filter((i) => {
        const t = new Date(i.completedAt!).getTime();
        return t >= dayStart.getTime() && t < dayEnd.getTime();
      }).length;
      completionTrend.push({ date: dateStr, count });
    }

    let avgCycleTime = 0;
    let avgLeadTime = 0;

    if (recentCompleted.length > 0) {
      const cycleTimes = recentCompleted.map((i) => {
        const start = i.columnEnteredAt ?? i.createdAt;
        return (
          (new Date(i.completedAt!).getTime() - new Date(start).getTime()) /
          86400000
        );
      });
      avgCycleTime =
        Math.round(
          (cycleTimes.reduce((s, v) => s + v, 0) / cycleTimes.length) * 100
        ) / 100;

      const leadTimes = recentCompleted.map(
        (i) =>
          (new Date(i.completedAt!).getTime() -
            new Date(i.createdAt).getTime()) /
          86400000
      );
      avgLeadTime =
        Math.round(
          (leadTimes.reduce((s, v) => s + v, 0) / leadTimes.length) * 100
        ) / 100;
    }

    return success({
      projectId,
      projectName: project.name,
      itemsByType,
      itemsByPriority,
      itemsByStatus,
      completionTrend,
      topAssignees,
      avgCycleTime,
      avgLeadTime,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
