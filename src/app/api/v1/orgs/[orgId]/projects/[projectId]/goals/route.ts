import { NextRequest } from "next/server";
import { GoalProgressMode } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireProjectRead, requireProjectVisible } from "@/lib/rbac/require-project-read";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { computeAutoProgress, type GoalWithLinks } from "@/lib/goals/rollup";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { createGoal, listGoals } from "./route.contract";
import { idempotent } from "@/lib/openapi/idempotency";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listGoals);
    const { params: { orgId, projectId } } = await parseRequest(listGoals, request, params);
    await requireProjectRead(ctx, projectId, "OKR_READ");

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
    });
    if (!project) return problem(404, "not_found", undefined, { request });

    const goals = await prisma.goal.findMany({
      where: { orgId, projectId },
      include: { links: { orderBy: { createdAt: "asc" } } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });

    const withProgress = await applyAutoProgress(orgId, goals);
    return respond(listGoals, 200, withProgress);
  } catch (e) {
    return handleApiError(e, request);
  }
}

/**
 * For AUTO goals, recompute `progress` by rolling up linked work items and
 * objectives. MANUAL goals are returned unchanged. Dangling links (deleted
 * item/objective) are tolerated by the resolver.
 */
async function applyAutoProgress(orgId: string, goals: GoalWithLinks[]) {
  const autoGoals = goals.filter(
    (g) => g.progressMode === GoalProgressMode.AUTO && g.links.length > 0,
  );
  if (autoGoals.length === 0) return goals;

  // Collect every referenced id across all AUTO goals so we resolve in two
  // queries rather than N per goal.
  const workItemIds = new Set<string>();
  const objectiveIds = new Set<string>();
  for (const g of autoGoals) {
    for (const link of g.links) {
      if (link.kind === "WORK_ITEM" && link.workItemId) workItemIds.add(link.workItemId);
      if (link.kind === "OBJECTIVE" && link.objectiveId) objectiveIds.add(link.objectiveId);
    }
  }

  const [workItems, objectives] = await Promise.all([
    workItemIds.size > 0
      ? prisma.workItem.findMany({
          where: { orgId, id: { in: [...workItemIds] } },
          select: { id: true, columnKey: true },
        })
      : Promise.resolve([]),
    objectiveIds.size > 0
      ? prisma.objective.findMany({
          where: { orgId, id: { in: [...objectiveIds] } },
          select: { id: true, progress: true },
        })
      : Promise.resolve([]),
  ]);

  const workItemById = new Map(workItems.map((w) => [w.id, w]));
  const objectiveById = new Map(objectives.map((o) => [o.id, o]));

  return goals.map((goal) => {
    if (goal.progressMode !== GoalProgressMode.AUTO || goal.links.length === 0) {
      return goal;
    }
    const rolled = computeAutoProgress(goal, workItemById, objectiveById);
    return rolled === null ? goal : { ...goal, progress: rolled };
  });
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, createGoal);
    const { params: { orgId, projectId }, body: data } = await parseRequest(createGoal, request, params);
    await requireProjectVisible(ctx, projectId);
    return await idempotent({ request, ctx, orgId, body: data }, async () => {
      await requireProjectManage(ctx, projectId, Permission.OKR_CREATE);

      const project = await prisma.project.findFirst({
        where: { id: projectId, orgId },
      });
      if (!project) return problem(404, "not_found", undefined, { request });

      const maxSort = await prisma.goal.aggregate({
        where: { orgId, projectId },
        _max: { sortOrder: true },
      });
      const sortOrder = (maxSort._max.sortOrder ?? -1) + 1;

      const created = await prisma.goal.create({
        data: {
          orgId,
          projectId,
          title: data.title,
          description: data.description ?? null,
          status: data.status,
          progressMode: data.progressMode,
          targetDate: data.targetDate ? new Date(data.targetDate) : null,
          ownerId: data.ownerId ?? null,
          progress: 0,
          sortOrder,
        },
        include: { links: { orderBy: { createdAt: "asc" } } },
      });

      return respond(createGoal, 200, created);
    });
  } catch (e) {
    return handleApiError(e, request);
  }
}
