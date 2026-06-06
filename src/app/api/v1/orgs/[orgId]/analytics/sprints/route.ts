import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * Sprint velocity analytics. "Sprints" are completed Cycles; this returns one
 * record per completed cycle in the shape the Sprint Velocity tab expects.
 * Previously this route didn't exist, so the client got a 404 (ambiguous
 * between "no data" and "endpoint missing"). It now returns 200 with an empty
 * array when a project has no completed cycles. [BUG-82]
 */
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
      return new Response(JSON.stringify({ error: "projectId is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const limit = Math.min(
      parseInt(request.nextUrl.searchParams.get("limit") ?? "10", 10),
      50,
    );

    const cycles = await prisma.cycle.findMany({
      where: { orgId, projectId, status: "COMPLETED" },
      orderBy: { number: "desc" },
      take: limit,
    });

    // Single batched query for every cycle's items (grouped in memory),
    // not one findMany per cycle — at limit=50 the per-cycle version fired 50
    // concurrent queries and could exhaust the connection pool.
    const cycleIds = cycles.map((c) => c.id);
    const allItems = await prisma.workItem.findMany({
      where: { orgId, projectId, cycleId: { in: cycleIds } },
      select: {
        cycleId: true,
        storyPoints: true,
        completedAt: true,
        columnEnteredAt: true,
        createdAt: true,
      },
    });
    const itemsByCycle = new Map<string, typeof allItems>();
    for (const item of allItems) {
      if (!item.cycleId) continue;
      const bucket = itemsByCycle.get(item.cycleId);
      if (bucket) bucket.push(item);
      else itemsByCycle.set(item.cycleId, [item]);
    }

    const sprints = cycles.map((cycle) => {
        const items = itemsByCycle.get(cycle.id) ?? [];

        const completed = items.filter((i) => i.completedAt);
        const totalPoints = items.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
        const completedPoints = completed.reduce(
          (s, i) => s + (i.storyPoints ?? 0),
          0,
        );

        let avgCycleTimeDays = 0;
        let avgLeadTimeDays = 0;
        if (completed.length > 0) {
          const cycleTimes = completed.map((i) => {
            const start = i.columnEnteredAt ?? i.createdAt;
            return (
              (new Date(i.completedAt!).getTime() - new Date(start).getTime()) /
              86_400_000
            );
          });
          avgCycleTimeDays =
            Math.round(
              (cycleTimes.reduce((s, v) => s + v, 0) / cycleTimes.length) * 100,
            ) / 100;

          const leadTimes = completed.map(
            (i) =>
              (new Date(i.completedAt!).getTime() -
                new Date(i.createdAt).getTime()) /
              86_400_000,
          );
          avgLeadTimeDays =
            Math.round(
              (leadTimes.reduce((s, v) => s + v, 0) / leadTimes.length) * 100,
            ) / 100;
        }

        return {
          sprintId: cycle.id,
          sprintName: cycle.name,
          velocity: completedPoints,
          completedPoints,
          totalPoints,
          completedItems: completed.length,
          totalItems: items.length,
          avgCycleTimeDays,
          avgLeadTimeDays,
        };
    });

    // Oldest → newest reads better on the velocity chart.
    sprints.reverse();

    return success(sprints);
  } catch (error) {
    return handleApiError(error);
  }
}
