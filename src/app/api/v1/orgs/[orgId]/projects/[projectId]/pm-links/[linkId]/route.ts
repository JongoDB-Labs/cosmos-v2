import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; linkId: string }>;
};

/**
 * DELETE /pm-links/[linkId] — remove a cross-reference. Scoped to org+project so
 * a link id from another tenant can't be deleted. Either end's owner (anyone
 * with PROJECT_UPDATE) may remove a reference; links are symmetric in intent.
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, linkId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await prisma.pmLink.findFirst({
      where: { id: linkId, orgId, projectId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.pmLink.delete({ where: { id: linkId } });
    return success({ id: linkId });
  } catch (error) {
    return handleApiError(error);
  }
}
