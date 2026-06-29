import { NextRequest } from "next/server";
import { z } from "zod";
import { ChangeRequestStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { logPmFieldChanges } from "@/lib/pm/activity-log";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; changeId: string }>;
};

const changeInclude = { programBranch: { select: { id: true, code: true, name: true } } };

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  type: z.string().max(80).nullish(),
  branchId: z.string().uuid().nullish(),
  initiatedBy: z.string().max(120).nullish(),
  decisionAuthority: z.string().max(120).nullish(),
  approvedBy: z.string().max(120).nullish(),
  costImpact: z.number().nullish(),
  scheduleDaysImpact: z.number().int().nullish(),
  modRequired: z.boolean().optional(),
  modNumber: z.string().max(80).nullish(),
  implDate: z.string().nullish(),
  relatedRiskCode: z.string().max(40).nullish(),
  status: z.nativeEnum(ChangeRequestStatus).optional(),
  submittedDate: z.string().nullish(),
  scopeImpact: z.string().nullish(),
  notes: z.string().nullish(),
});

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, changeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await prisma.changeRequest.findFirst({ where: { id: changeId, orgId, projectId } });
    if (!existing) return new Response("Not found", { status: 404 });

    const data = updateSchema.parse(await request.json());

    const updated = await prisma.changeRequest.update({
      where: { id: changeId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.type !== undefined && { type: data.type }),
        ...(data.branchId !== undefined && { branchId: data.branchId }),
        ...(data.initiatedBy !== undefined && { initiatedBy: data.initiatedBy }),
        ...(data.decisionAuthority !== undefined && { decisionAuthority: data.decisionAuthority }),
        ...(data.approvedBy !== undefined && { approvedBy: data.approvedBy }),
        ...(data.costImpact !== undefined && { costImpact: data.costImpact }),
        ...(data.scheduleDaysImpact !== undefined && { scheduleDaysImpact: data.scheduleDaysImpact }),
        ...(data.modRequired !== undefined && { modRequired: data.modRequired }),
        ...(data.modNumber !== undefined && { modNumber: data.modNumber }),
        ...(data.implDate !== undefined && {
          implDate: data.implDate ? new Date(data.implDate) : null,
        }),
        ...(data.relatedRiskCode !== undefined && { relatedRiskCode: data.relatedRiskCode }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.submittedDate !== undefined && {
          submittedDate: data.submittedDate ? new Date(data.submittedDate) : null,
        }),
        ...(data.scopeImpact !== undefined && { scopeImpact: data.scopeImpact }),
        ...(data.notes !== undefined && { notes: data.notes }),
      },
      include: changeInclude,
    });

    // Audit field changes (best-effort). Label-keyed maps so the Activity log
    // reads "changed Status: SUBMITTED → APPROVED". Only the audited fields below
    // are diffed; `logPmFieldChanges` skips keys whose before === after.
    await logPmFieldChanges(
      { orgId, subjectType: "change", subjectId: changeId, userId: ctx.userId },
      {
        title: existing.title,
        status: existing.status,
        type: existing.type,
        branchId: existing.branchId,
        initiatedBy: existing.initiatedBy,
        decisionAuthority: existing.decisionAuthority,
        approvedBy: existing.approvedBy,
        costImpact: existing.costImpact,
        scheduleDaysImpact: existing.scheduleDaysImpact,
        modRequired: existing.modRequired,
        modNumber: existing.modNumber,
        relatedRiskCode: existing.relatedRiskCode,
      },
      {
        title: updated.title,
        status: updated.status,
        type: updated.type,
        branchId: updated.branchId,
        initiatedBy: updated.initiatedBy,
        decisionAuthority: updated.decisionAuthority,
        approvedBy: updated.approvedBy,
        costImpact: updated.costImpact,
        scheduleDaysImpact: updated.scheduleDaysImpact,
        modRequired: updated.modRequired,
        modNumber: updated.modNumber,
        relatedRiskCode: updated.relatedRiskCode,
      },
    );

    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, changeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await prisma.changeRequest.findFirst({ where: { id: changeId, orgId, projectId } });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.changeRequest.delete({ where: { id: changeId } });
    return success({ id: changeId });
  } catch (e) {
    return handleApiError(e);
  }
}
