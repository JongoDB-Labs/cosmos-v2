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
    milestoneId: string;
    linkId: string;
  }>;
};

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, milestoneId, linkId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    // Scope the link to the milestone, and the milestone to org+project, so a
    // caller can't delete a link belonging to another tenant's milestone.
    const milestone = await prisma.milestone.findFirst({
      where: { id: milestoneId, orgId, projectId },
      select: { id: true },
    });
    if (!milestone) return new Response("Not found", { status: 404 });

    const link = await prisma.milestoneLink.findFirst({
      where: { id: linkId, milestoneId },
    });
    if (!link) return new Response("Not found", { status: 404 });

    await prisma.milestoneLink.delete({ where: { id: linkId } });

    return success({ id: linkId });
  } catch (e) {
    return handleApiError(e);
  }
}
