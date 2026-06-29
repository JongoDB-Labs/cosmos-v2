import { NextRequest } from "next/server";
import { z } from "zod";
import { ProjectRole, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { logPmFieldChanges } from "@/lib/pm/activity-log";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; memberId: string }>;
};

const updateSchema = z.object({
  allocationPercent: z.number().int().min(0).max(100).nullish(),
  role: z.nativeEnum(ProjectRole).optional(),
  onContract: z.boolean().optional(),
  cacStatus: z.string().max(40).nullish(),
  cacExpiry: z.string().nullish(),
  trainingStatus: z.string().max(40).nullish(),
  accessStatus: z.string().max(40).nullish(),
  ndaStatus: z.string().max(40).nullish(),
  complianceNotes: z.string().nullish(),
});

// Membership is created/removed on the Members page; the staffing register only
// edits the PM-owned fields (allocation + project role).
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, memberId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const member = await prisma.projectMember.findFirst({
      where: { id: memberId, projectId, project: { orgId } },
    });
    if (!member) return new Response("Not found", { status: 404 });

    const data = updateSchema.parse(await request.json());
    const update: Prisma.ProjectMemberUncheckedUpdateInput = {};
    if (data.allocationPercent !== undefined)
      update.allocationPercent = data.allocationPercent ?? null;
    if (data.role !== undefined) update.role = data.role;
    if (data.onContract !== undefined) update.onContract = data.onContract;
    if (data.cacStatus !== undefined) update.cacStatus = data.cacStatus ?? null;
    if (data.cacExpiry !== undefined)
      update.cacExpiry = data.cacExpiry ? new Date(data.cacExpiry) : null;
    if (data.trainingStatus !== undefined) update.trainingStatus = data.trainingStatus ?? null;
    if (data.accessStatus !== undefined) update.accessStatus = data.accessStatus ?? null;
    if (data.ndaStatus !== undefined) update.ndaStatus = data.ndaStatus ?? null;
    if (data.complianceNotes !== undefined)
      update.complianceNotes = data.complianceNotes ?? null;

    const updated = await prisma.projectMember.update({ where: { id: memberId }, data: update });

    // Audit field changes (best-effort). `logPmFieldChanges` skips keys whose
    // before === after, so an unchanged PATCH writes no activity rows.
    await logPmFieldChanges(
      { orgId, subjectType: "staff", subjectId: memberId, userId: ctx.userId },
      {
        role: member.role,
        allocationPercent: member.allocationPercent,
        onContract: member.onContract,
        cacStatus: member.cacStatus,
        trainingStatus: member.trainingStatus,
        accessStatus: member.accessStatus,
        ndaStatus: member.ndaStatus,
      },
      {
        role: updated.role,
        allocationPercent: updated.allocationPercent,
        onContract: updated.onContract,
        cacStatus: updated.cacStatus,
        trainingStatus: updated.trainingStatus,
        accessStatus: updated.accessStatus,
        ndaStatus: updated.ndaStatus,
      },
    );

    return success({ id: memberId });
  } catch (e) {
    return handleApiError(e);
  }
}
