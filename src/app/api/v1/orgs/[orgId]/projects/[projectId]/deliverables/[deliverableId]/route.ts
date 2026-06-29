import { NextRequest } from "next/server";
import { z } from "zod";
import { DeliverableStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; deliverableId: string }>;
};

const deliverableInclude = { programBranch: { select: { id: true, code: true, name: true } } };

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  deliverableType: z.string().max(80).nullish(),
  clin: z.string().max(80).nullish(),
  branchId: z.string().uuid().nullish(),
  owner: z.string().max(120).nullish(),
  baselineDue: z.string().nullish(),
  internalReview: z.string().nullish(),
  actualSubmission: z.string().nullish(),
  govReviewPeriod: z.number().int().nullish(),
  govAcceptance: z.string().nullish(),
  revisionCycle: z.number().int().optional(),
  revRequired: z.boolean().optional(),
  escalate: z.boolean().optional(),
  status: z.nativeEnum(DeliverableStatus).optional(),
  branchOwner: z.string().nullish(),
  workItemRef: z.string().nullish(),
  notes: z.string().nullish(),
});

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, deliverableId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await prisma.deliverable.findFirst({ where: { id: deliverableId, orgId, projectId } });
    if (!existing) return new Response("Not found", { status: 404 });

    const data = updateSchema.parse(await request.json());

    const updateData: Prisma.DeliverableUncheckedUpdateInput = {};
    if (data.title !== undefined) updateData.title = data.title;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.deliverableType !== undefined) updateData.deliverableType = data.deliverableType;
    if (data.clin !== undefined) updateData.clin = data.clin;
    if (data.branchId !== undefined) updateData.branchId = data.branchId;
    if (data.owner !== undefined) updateData.owner = data.owner;
    if (data.baselineDue !== undefined) updateData.baselineDue = data.baselineDue ? new Date(data.baselineDue) : null;
    if (data.internalReview !== undefined) updateData.internalReview = data.internalReview ? new Date(data.internalReview) : null;
    if (data.actualSubmission !== undefined) updateData.actualSubmission = data.actualSubmission ? new Date(data.actualSubmission) : null;
    if (data.govReviewPeriod !== undefined) updateData.govReviewPeriod = data.govReviewPeriod;
    if (data.govAcceptance !== undefined) updateData.govAcceptance = data.govAcceptance ? new Date(data.govAcceptance) : null;
    if (data.revisionCycle !== undefined) updateData.revisionCycle = data.revisionCycle;
    if (data.revRequired !== undefined) updateData.revRequired = data.revRequired;
    if (data.escalate !== undefined) updateData.escalate = data.escalate;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.branchOwner !== undefined) updateData.branchOwner = data.branchOwner ?? null;
    if (data.workItemRef !== undefined) updateData.workItemRef = data.workItemRef ?? null;
    if (data.notes !== undefined) updateData.notes = data.notes ?? null;

    const updated = await prisma.deliverable.update({
      where: { id: deliverableId },
      data: updateData,
      include: deliverableInclude,
    });
    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, deliverableId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await prisma.deliverable.findFirst({ where: { id: deliverableId, orgId, projectId } });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.deliverable.delete({ where: { id: deliverableId } });
    return success({ id: deliverableId });
  } catch (e) {
    return handleApiError(e);
  }
}
