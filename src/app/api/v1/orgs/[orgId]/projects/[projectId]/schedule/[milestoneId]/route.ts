import { NextRequest } from "next/server";
import { z } from "zod";
import { MilestoneStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; milestoneId: string }>;
};

const milestoneInclude = {
  programBranch: { select: { id: true, code: true, name: true } },
};

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  phase: z.string().max(120).nullish(),
  branchId: z.string().uuid().nullish(),
  baselineDate: z.string().nullish(),
  dueDate: z.string().optional(),
  actualDate: z.string().nullish(),
  status: z.nativeEnum(MilestoneStatus).optional(),
  rootCause: z.string().nullish(),
  recoveryPlan: z.string().nullish(),
  recoveryTarget: z.string().nullish(),
  scheduleEscalate: z.boolean().optional(),
  autoStatus: z.boolean().optional(),
  milestoneType: z.string().nullish(),
  downstreamImpact: z.string().nullish(),
  relatedRef: z.string().nullish(),
  notes: z.string().nullish(),
});

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, milestoneId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await prisma.milestone.findFirst({
      where: { id: milestoneId, orgId, projectId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const data = updateSchema.parse(await request.json());

    // Build a typed update object to avoid Prisma discriminated-union TS errors
    const update: Prisma.MilestoneUncheckedUpdateInput = {};
    if (data.title !== undefined) update.title = data.title;
    if (data.description !== undefined) update.description = data.description ?? null;
    if (data.phase !== undefined) update.phase = data.phase ?? null;
    if (data.branchId !== undefined) update.branchId = data.branchId ?? null;
    if (data.baselineDate !== undefined)
      update.baselineDate = data.baselineDate ? new Date(data.baselineDate) : null;
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
    if (data.milestoneType !== undefined) update.milestoneType = data.milestoneType ?? null;
    if (data.downstreamImpact !== undefined) update.downstreamImpact = data.downstreamImpact ?? null;
    if (data.relatedRef !== undefined) update.relatedRef = data.relatedRef ?? null;
    if (data.notes !== undefined) update.notes = data.notes ?? null;

    const updated = await prisma.milestone.update({
      where: { id: milestoneId },
      data: update,
      include: milestoneInclude,
    });
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
    requirePermission(ctx, Permission.PROJECT_UPDATE);

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
