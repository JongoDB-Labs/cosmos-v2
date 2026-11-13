import { NextRequest } from "next/server";
import { z } from "zod";
import { ProjectRole, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { canManageProject } from "@/lib/rbac/scope";
import { logPmFieldChanges } from "@/lib/pm/activity-log";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";

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
    await requireProjectVisible(ctx, projectId);
    await requireProjectManage(ctx, projectId, Permission.PROJECT_UPDATE);

    const member = await prisma.projectMember.findFirst({
      where: { id: memberId, projectId, project: { orgId } },
    });
    if (!member) return new Response("Not found", { status: 404 });

    const data = updateSchema.parse(await request.json());

    // A project role is access control, not a staffing detail: MANAGER runs the
    // project's members, teams, boards and registers. So changing one takes
    // what the Members page takes (an org admin, or a MANAGER of this project;
    // see members/route.ts), never PROJECT_UPDATE alone, and never an API key,
    // whatever its scopes. The PM fields below keep the register's own gate.
    const roleChange = data.role !== undefined && data.role !== member.role;
    if (roleChange && (ctx.isApiKey || !(await canManageProject(ctx, projectId, Permission.PROJECT_MANAGE)))) {
      return Response.json(
        { error: "You must be a project manager or an org admin to change someone's project role." },
        { status: 403 },
      );
    }

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

    // Recorded as the Members page records it, so every role change is in the
    // audit log whichever screen made it.
    if (roleChange) {
      await logAudit({
        orgId,
        userId: ctx.userId,
        action: "project_member.set",
        entity: "project",
        entityId: projectId,
        metadata: { orgMemberId: member.orgMemberId, role: updated.role, from: member.role } as Record<string, string>,
        ipAddress: getIpAddress(request),
      });
    }

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
