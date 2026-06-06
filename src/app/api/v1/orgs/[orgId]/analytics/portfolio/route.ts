import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ANALYTICS_READ);

    const projects = await prisma.project.findMany({
      where: { orgId, archived: false },
      select: { id: true, name: true, key: true },
      orderBy: { name: "asc" },
    });

    const now = new Date();

    const portfolio = await Promise.all(
      projects.map(async (project) => {
        const boards = await prisma.board.findMany({
          where: { projectId: project.id },
          select: { id: true },
        });
        const boardIds = boards.map((b) => b.id);

        const doneColumns = boardIds.length > 0
          ? await prisma.boardColumn.findMany({
              where: { boardId: { in: boardIds }, category: "DONE" },
              select: { key: true },
            })
          : [];
        const doneKeys = doneColumns.map((c) => c.key);

        const inProgressColumns = boardIds.length > 0
          ? await prisma.boardColumn.findMany({
              where: { boardId: { in: boardIds }, category: "IN_PROGRESS" },
              select: { key: true },
            })
          : [];
        const inProgressKeys = inProgressColumns.map((c) => c.key);

        const totalItems = await prisma.workItem.count({
          where: { orgId, projectId: project.id },
        });

        const completedItems =
          doneKeys.length > 0
            ? await prisma.workItem.count({
                where: { orgId, projectId: project.id, columnKey: { in: doneKeys } },
              })
            : 0;

        const inProgressItems =
          inProgressKeys.length > 0
            ? await prisma.workItem.count({
                where: {
                  orgId,
                  projectId: project.id,
                  columnKey: { in: inProgressKeys },
                },
              })
            : 0;

        const overdueItems = await prisma.workItem.count({
          where: {
            orgId,
            projectId: project.id,
            completedAt: null,
            dueDate: { lt: now },
          },
        });

        const completionPercentage =
          totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

        const activeCycle = await prisma.cycle.findFirst({
          where: { orgId, projectId: project.id, status: "ACTIVE" },
          select: { name: true },
        });

        return {
          projectId: project.id,
          projectName: project.name,
          projectKey: project.key,
          totalItems,
          completedItems,
          inProgressItems,
          overdueItems,
          // Field names must match the client's PortfolioProject contract
          // (src/components/analytics/analytics-dashboard.tsx); the dashboard
          // consumes this response unmapped, so a name drift renders as a bare
          // "%" with no number and a NaN-width progress bar.
          completionPercent: completionPercentage,
          activeSprint: activeCycle?.name ?? null,
        };
      })
    );

    return success(portfolio);
  } catch (error) {
    return handleApiError(error);
  }
}
