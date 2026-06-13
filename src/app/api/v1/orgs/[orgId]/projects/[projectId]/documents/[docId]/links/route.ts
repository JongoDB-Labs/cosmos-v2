import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; docId: string }>;
};

/** GET — the document's block→item links, with the linked work-item resolved
 *  (title + ticket) so the Files view can show "linked" badges. */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, docId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_READ);

    const links = await prisma.documentItemLink.findMany({
      where: { orgId, projectId, block: { documentId: docId } },
      select: { id: true, blockId: true, itemType: true, itemId: true },
    });

    const workItemIds = links.filter((l) => l.itemType === "WORK_ITEM").map((l) => l.itemId);
    const items = workItemIds.length
      ? await prisma.workItem.findMany({
          where: { id: { in: workItemIds }, orgId, projectId },
          select: { id: true, title: true, ticketNumber: true },
        })
      : [];
    const byId = new Map(items.map((i) => [i.id, i]));

    return success(
      links.map((l) => ({ ...l, item: byId.get(l.itemId) ?? null })),
    );
  } catch (e) {
    return handleApiError(e);
  }
}
