import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{
    orgId: string;
    projectId: string;
    goalId: string;
    linkId: string;
  }>;
};

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, goalId, linkId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.OKR_UPDATE);

    // Scope the link to its goal, and the goal to org+project, so a caller can't
    // delete a link belonging to another tenant's goal.
    const goal = await prisma.goal.findFirst({
      where: { id: goalId, orgId, projectId },
      select: { id: true },
    });
    if (!goal) return new Response("Not found", { status: 404 });

    const link = await prisma.goalLink.findFirst({
      where: { id: linkId, goalId },
      select: { id: true },
    });
    if (!link) return new Response("Not found", { status: 404 });

    await prisma.goalLink.delete({ where: { id: linkId } });

    return success({ id: linkId });
  } catch (e) {
    return handleApiError(e);
  }
}
