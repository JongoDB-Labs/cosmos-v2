import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { publishToOrg } from "@/lib/realtime/broker";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { deleteWorkItemLink } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; linkId: string }> };

/** DELETE — remove a work-item dependency link (scoped to this org+project). */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, deleteWorkItemLink);
    const { params: { orgId, projectId, linkId } } = await parseRequest(deleteWorkItemLink, request, params);
    await requireProjectManage(ctx, projectId, Permission.ITEM_UPDATE);

    // Scope the delete to a link in THIS org whose source item is in THIS
    // project — a link from another tenant/project is a 404, never deleted.
    const link = await prisma.workItemLink.findFirst({
      where: { id: linkId, orgId, sourceItem: { projectId } },
      select: { id: true, sourceItemId: true, targetItemId: true, type: true },
    });
    if (!link) return problem(404, "not_found", undefined, { request });

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

    return respond(deleteWorkItemLink, 204, undefined);
  } catch (error) {
    return handleApiError(error, request);
  }
}
