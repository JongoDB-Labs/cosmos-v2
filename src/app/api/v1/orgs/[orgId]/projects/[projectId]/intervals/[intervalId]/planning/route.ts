import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { success, handleApiError } from "@/lib/api-helpers";
import {
  capacityUnitForSector,
  committedTotal,
  suggestMemberCapacity,
  DEFAULT_POINTS_CAPACITY,
  DEFAULT_HOURS_CAPACITY,
} from "@/lib/intervals/sprint-planning";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; intervalId: string }>;
};

/**
 * Planning inputs for the Start Sprint flow: the project's capacity unit, the
 * sprint goal, the committed-scope total (from items already in the interval), and
 * per-member capacity suggestions (recent velocity for points projects, a
 * standard constant otherwise) alongside any capacity already saved.
 *
 * The client merges these onto the org member roster; suggestions only carry
 * members with history, so brand-new members fall back to `defaultCapacity`.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectRead(ctx, projectId, "SPRINT_READ");

    const interval = await prisma.interval.findFirst({
      where: { id: intervalId, orgId, projectId },
      select: { id: true, goal: true },
    });
    if (!interval) return new Response("Interval not found", { status: 404 });

    // Resolve the capacity unit from the project's template sector.
    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
      select: { projectTemplate: { select: { sector: true } } },
    });
    const unit = capacityUnitForSector(project?.projectTemplate?.sector);

    // Optional team scope. A ceremony belongs to a squad, and a lead planning
    // their own sprint should not be sizing work for people they do not run.
    //
    // Capacity and committed are scoped TOGETHER or not at all. Scoping one and
    // not the other would measure a team's hours against the whole project's
    // commitment and report a headroom that is confidently wrong, which is worse
    // than one that is plainly absent.
    const teamId = request.nextUrl.searchParams.get("teamId");
    let teamUserIds: string[] | null = null;
    if (teamId) {
      const team = await prisma.team.findFirst({
        where: { id: teamId, projectId },
        select: {
          members: {
            select: {
              projectMember: { select: { orgMember: { select: { userId: true } } } },
            },
          },
        },
      });
      // A team that does not exist, or belongs to another project, scopes to
      // NOBODY rather than falling back to the whole project — failing open here
      // would put every squad back in the room, which is the bug being fixed.
      teamUserIds = (team?.members ?? []).map(
        (m) => m.projectMember.orgMember.userId,
      );
    }
    const scopedToTeam = <T,>(map: Record<string, T>): Record<string, T> => {
      if (!teamUserIds) return map;
      const allow = new Set(teamUserIds);
      return Object.fromEntries(Object.entries(map).filter(([u]) => allow.has(u)));
    };

    // Committed scope: everything currently pulled into the sprint. Narrowed by
    // the OWNER (`assigneeId`) — the same key the velocity suggestions below
    // use, so both halves of the panel count the same people.
    const items = await prisma.workItem.findMany({
      where: {
        orgId,
        projectId,
        intervalId,
        ...(teamUserIds ? { assigneeId: { in: teamUserIds } } : {}),
      },
      select: { storyPoints: true, originalEstimate: true },
    });
    const committed = {
      total: committedTotal(items, unit),
      itemCount: items.length,
    };

    // Capacity already saved for this interval (userId → capacity).
    const existing = await prisma.intervalCapacity.findMany({
      where: { intervalId },
      select: { userId: true, capacity: true },
    });
    const current: Record<string, number> = {};
    for (const c of existing) current[c.userId] = c.capacity;

    // Per-member suggestion from the last 3 completed sprints (points only —
    // hours projects use a constant, so history isn't needed there).
    const suggestions: Record<string, number> = {};
    if (unit === "points") {
      const completed = await prisma.interval.findMany({
        where: { orgId, projectId, status: "COMPLETED" },
        orderBy: { number: "desc" },
        take: 3,
        select: { id: true },
      });
      const completedIds = completed.map((c) => c.id);
      if (completedIds.length > 0) {
        const histItems = await prisma.workItem.findMany({
          where: {
            orgId,
            projectId,
            intervalId: { in: completedIds },
            completedAt: { not: null },
          },
          select: { assigneeId: true, storyPoints: true, intervalId: true },
        });
        // userId → (intervalId → completed points in that sprint)
        const perMember = new Map<string, Map<string, number>>();
        for (const it of histItems) {
          if (!it.assigneeId) continue;
          const byInterval = perMember.get(it.assigneeId) ?? new Map<string, number>();
          byInterval.set(
            it.intervalId!,
            (byInterval.get(it.intervalId!) ?? 0) + (it.storyPoints ?? 0),
          );
          perMember.set(it.assigneeId, byInterval);
        }
        for (const [userId, byInterval] of perMember) {
          const recent = completedIds.map((id) => byInterval.get(id) ?? 0);
          suggestions[userId] = suggestMemberCapacity(unit, recent);
        }
      }
    }

    return success({
      unit,
      goal: interval.goal ?? "",
      committed,
      // Both keyed by userId, both narrowed to the same roster as `committed`.
      current: scopedToTeam(current),
      suggestions: scopedToTeam(suggestions),
      defaultCapacity:
        unit === "points" ? DEFAULT_POINTS_CAPACITY : DEFAULT_HOURS_CAPACITY,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
