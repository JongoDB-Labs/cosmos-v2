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

    await prisma.projectMember.update({ where: { id: memberId }, data: update });
    return success({ id: memberId });
  } catch (e) {
    return handleApiError(e);
  }
}
