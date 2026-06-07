import { NextRequest } from "next/server";
import { z } from "zod";
import { GoalStatus, GoalProgressMode } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { computeAutoProgress, type GoalWithLinks } from "@/lib/goals/rollup";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.OKR_READ);

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
    });
    if (!project) return new Response("Not found", { status: 404 });

    const goals = await prisma.goal.findMany({
      where: { orgId, projectId },
      include: { links: { orderBy: { createdAt: "asc" } } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });

    const withProgress = await applyAutoProgress(orgId, goals);
    return success(withProgress);
  } catch (e) {
    return handleApiError(e);
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

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  status: z.nativeEnum(GoalStatus).default(GoalStatus.PLANNED),
  targetDate: z.string().datetime().nullish(),
  progressMode: z.nativeEnum(GoalProgressMode).default(GoalProgressMode.MANUAL),
  ownerId: z.string().uuid().nullish(),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.OKR_CREATE);

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
    });
    if (!project) return new Response("Not found", { status: 404 });

    const data = createSchema.parse(await request.json());

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

    return success(created);
  } catch (e) {
    return handleApiError(e);
  }
}
