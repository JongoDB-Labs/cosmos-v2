import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { publishToOrg } from "@/lib/realtime/broker";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; linkId: string }> };

/** DELETE — remove a work-item dependency link (scoped to this org+project). */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, linkId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_UPDATE);

    // Scope the delete to a link in THIS org whose source item is in THIS
    // project — a link from another tenant/project is a 404, never deleted.
    const link = await prisma.workItemLink.findFirst({
      where: { id: linkId, orgId, sourceItem: { projectId } },
      select: { id: true, sourceItemId: true, targetItemId: true, type: true },
    });
    if (!link) return new Response("Not found", { status: 404 });

    await prisma.workItemLink.delete({ where: { id: linkId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "work_item_link.delete",
      entity: "work_item_link",
      entityId: linkId,
      metadata: { sourceItemId: link.sourceItemId, targetItemId: link.targetItemId, type: link.type },
      ipAddress: getIpAddress(request),
    });
    publishToOrg(orgId, "work-item-link.deleted", { projectId, linkId });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
