import { NextRequest } from "next/server";
import { z } from "zod";
import { MilestoneStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { assertMilestoneInterval } from "@/lib/pm/milestone-interval";
import { logPmFieldChanges } from "@/lib/pm/activity-log";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; milestoneId: string }>;
};

const milestoneInclude = {
  interval: {
    select: { id: true, number: true, name: true, startDate: true, endDate: true },
  },
};

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  intervalId: z.string().uuid().nullish(),
  dueDate: z.string().optional(),
  actualDate: z.string().nullish(),
  status: z.nativeEnum(MilestoneStatus).optional(),
  rootCause: z.string().nullish(),
  recoveryPlan: z.string().nullish(),
  recoveryTarget: z.string().nullish(),
  scheduleEscalate: z.boolean().optional(),
  autoStatus: z.boolean().optional(),
  downstreamImpact: z.string().nullish(),
  notes: z.string().nullish(),
});

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, milestoneId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectManage(ctx, projectId, Permission.PROJECT_UPDATE);

    const existing = await prisma.milestone.findFirst({
      where: { id: milestoneId, orgId, projectId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const data = updateSchema.parse(await request.json());
    await assertMilestoneInterval(data.intervalId, orgId, projectId);

    // Build a typed update object to avoid Prisma discriminated-union TS errors
    const update: Prisma.MilestoneUncheckedUpdateInput = {};
    if (data.title !== undefined) update.title = data.title;
    if (data.description !== undefined) update.description = data.description ?? null;
    if (data.intervalId !== undefined) update.intervalId = data.intervalId ?? null;
    if (data.dueDate !== undefined) update.dueDate = new Date(data.dueDate);
    if (data.actualDate !== undefined)
      update.actualDate = data.actualDate ? new Date(data.actualDate) : null;
    if (data.status !== undefined) update.status = data.status;
    if (data.rootCause !== undefined) update.rootCause = data.rootCause ?? null;
    if (data.recoveryPlan !== undefined) update.recoveryPlan = data.recoveryPlan ?? null;
    if (data.recoveryTarget !== undefined)
      update.recoveryTarget = data.recoveryTarget ? new Date(data.recoveryTarget) : null;
    if (data.scheduleEscalate !== undefined) update.scheduleEscalate = data.scheduleEscalate;
    if (data.autoStatus !== undefined) update.autoStatus = data.autoStatus;
    if (data.downstreamImpact !== undefined) update.downstreamImpact = data.downstreamImpact ?? null;
    if (data.notes !== undefined) update.notes = data.notes ?? null;

    const updated = await prisma.milestone.update({
      where: { id: milestoneId },
      data: update,
      include: milestoneInclude,
    });

    // Audit field changes (best-effort). Label-keyed maps so the Activity log
    // reads "changed status: UPCOMING → COMPLETED". Date fields (dueDate) are
    // Date objects — actVal slices them to yyyy-mm-dd. Only the audited fields
    // below are diffed; logPmFieldChanges skips before === after.
    await logPmFieldChanges(
      { orgId, subjectType: "milestone", subjectId: milestoneId, userId: ctx.userId },
      {
        title: existing.title,
        status: existing.status,
        intervalId: existing.intervalId,
        dueDate: existing.dueDate,
        scheduleEscalate: existing.scheduleEscalate,
        autoStatus: existing.autoStatus,
      },
      {
        title: updated.title,
        status: updated.status,
        intervalId: updated.intervalId,
        dueDate: updated.dueDate,
        scheduleEscalate: updated.scheduleEscalate,
        autoStatus: updated.autoStatus,
      },
    );

    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, milestoneId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectManage(ctx, projectId, Permission.PROJECT_UPDATE);

    const existing = await prisma.milestone.findFirst({
      where: { id: milestoneId, orgId, projectId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.milestone.delete({ where: { id: milestoneId } });
    return success({ id: milestoneId });
  } catch (e) {
    return handleApiError(e);
  }
}
