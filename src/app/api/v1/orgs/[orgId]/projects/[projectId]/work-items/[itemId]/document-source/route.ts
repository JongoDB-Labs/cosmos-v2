import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { success, handleApiError } from "@/lib/api-helpers";
import { readableProjectDocument } from "@/lib/files/access";

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
    await requireProjectRead(ctx, projectId, "PROJECT_READ");

    const link = await prisma.documentItemLink.findFirst({
      where: { orgId, projectId, itemType: "WORK_ITEM", itemId },
      select: {
        block: { select: { anchor: true, document: { select: { id: true, title: true } } } },
      },
    });
    if (!link) return success(null);
    // The chip names the file, and a restricted file's name is not for every
    // reader of the item. Somebody who may not see it gets no chip, exactly as
    // for an item that was never made from a document.
    if (!(await readableProjectDocument(orgId, projectId, link.block.document.id, ctx)))
      return success(null);

    return success({
      docId: link.block.document.id,
      docTitle: link.block.document.title,
      blockAnchor: link.block.anchor,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
