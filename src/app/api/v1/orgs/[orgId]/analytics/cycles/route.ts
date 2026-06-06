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

    const projectId = request.nextUrl.searchParams.get("projectId");
    if (!projectId) {
      return new Response(
        JSON.stringify({ error: "projectId is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const limit = Math.min(
      parseInt(request.nextUrl.searchParams.get("limit") ?? "10", 10),
      50
    );

    const cycles = await prisma.cycle.findMany({
      where: { orgId, projectId, status: "COMPLETED" },
      orderBy: { number: "desc" },
      take: limit,
    });

    const analytics = await Promise.all(
      cycles.map(async (cycle) => {
        const items = await prisma.workItem.findMany({
          where: { orgId, projectId, cycleId: cycle.id },
          select: {
            id: true,
            storyPoints: true,
            completedAt: true,
            columnEnteredAt: true,
            createdAt: true,
          },
        });

        const completedItems = items.filter((i) => i.completedAt);
        const velocity = completedItems.reduce(
          (sum, i) => sum + (i.storyPoints ?? 0),
          0
        );

        let avgCycleTime = 0;
        let avgLeadTime = 0;

        if (completedItems.length > 0) {
          const cycleTimes = completedItems.map((i) => {
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

          const leadTimes = completedItems.map(
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

        return {
          cycleId: cycle.id,
          cycleName: cycle.name,
          cycleNumber: cycle.number,
          velocity,
          totalItems: items.length,
          completedItems: completedItems.length,
          avgCycleTime,
          avgLeadTime,
        };
      })
    );

    return success(analytics);
  } catch (error) {
    return handleApiError(error);
  }
}
