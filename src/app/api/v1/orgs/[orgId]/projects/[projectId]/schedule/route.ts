import { NextRequest } from "next/server";
import { z } from "zod";
import { MilestoneStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { loadMilestonesWithDerived } from "@/lib/pm/schedule";
import { logPmActivity } from "@/lib/pm/activity-log";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

const milestoneInclude = {
  programBranch: { select: { id: true, code: true, name: true } },
};

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ANALYTICS_READ);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    // Status + completion derive from linked work items (see lib/pm/schedule).
    const milestones = await loadMilestonesWithDerived(orgId, projectId);
    return success(milestones);
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  phase: z.string().max(120).nullish(),
  branchId: z.string().uuid().nullish(),
  dueDate: z.string().min(1), // required
  actualDate: z.string().nullish(),
  status: z.nativeEnum(MilestoneStatus).default(MilestoneStatus.UPCOMING),
  rootCause: z.string().nullish(),
  recoveryPlan: z.string().nullish(),
  recoveryTarget: z.string().nullish(),
  scheduleEscalate: z.boolean().default(false),
  autoStatus: z.boolean().default(true), // derive status from linked work items
  milestoneType: z.string().nullish(),
  downstreamImpact: z.string().nullish(),
  relatedRef: z.string().nullish(),
  notes: z.string().nullish(),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const data = createSchema.parse(await request.json());
    const dueDate = new Date(data.dueDate);

    const created = await prisma.milestone.create({
      data: {
        orgId,
        projectId,
        title: data.title,
        description: data.description ?? null,
        phase: data.phase ?? null,
        branchId: data.branchId ?? null,
        dueDate,
        actualDate: data.actualDate ? new Date(data.actualDate) : null,
        status: data.status,
        rootCause: data.rootCause ?? null,
        recoveryPlan: data.recoveryPlan ?? null,
        recoveryTarget: data.recoveryTarget ? new Date(data.recoveryTarget) : null,
        scheduleEscalate: data.scheduleEscalate,
        autoStatus: data.autoStatus,
        milestoneType: data.milestoneType ?? null,
        downstreamImpact: data.downstreamImpact ?? null,
        relatedRef: data.relatedRef ?? null,
        notes: data.notes ?? null,
      },
      include: milestoneInclude,
    });

    // Seed the activity log with a "created" event (best-effort).
    await logPmActivity({
      orgId,
      subjectType: "milestone",
      subjectId: created.id,
      userId: ctx.userId,
      action: "created",
    });

    return success(created);
  } catch (e) {
    return handleApiError(e);
  }
}
