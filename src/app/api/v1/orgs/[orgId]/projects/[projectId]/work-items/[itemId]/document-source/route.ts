import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; itemId: string }>;
};

/** GET — the document block this work item was created from (if any), so the item
 *  detail can show a "Source" chip linking back into the Files tab. Null if none. */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_READ);

    const link = await prisma.documentItemLink.findFirst({
      where: { orgId, projectId, itemType: "WORK_ITEM", itemId },
      select: {
        block: { select: { anchor: true, document: { select: { id: true, title: true } } } },
      },
    });
    if (!link) return success(null);

    return success({
      docId: link.block.document.id,
      docTitle: link.block.document.title,
      blockAnchor: link.block.anchor,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
