import { NextRequest } from "next/server";
import { z } from "zod";
import { ProjectRole, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

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

    await prisma.projectMember.update({ where: { id: memberId }, data: update });
    return success({ id: memberId });
  } catch (e) {
    return handleApiError(e);
  }
}
