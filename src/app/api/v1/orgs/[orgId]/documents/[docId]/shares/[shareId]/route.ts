import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { readableDocument, canManageDocument } from "@/lib/files/access";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; docId: string; shareId: string }> };

/** DELETE — stop sharing it with one person. */
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, docId, shareId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const doc = await readableDocument(orgId, docId, ctx);
    if (!doc) return new Response("Not found", { status: 404 });
    if (!(await canManageDocument(doc, ctx)))
      return new Response("You did not upload this file and cannot change who sees it", {
        status: 403,
      });

    // Scoped on the document as well as the id, so a share id belonging to a
    // different file cannot be revoked through this one's door.
    const share = await prisma.documentShare.findFirst({
      where: { id: shareId, orgId, documentId: docId },
      select: { id: true, userId: true },
    });
    if (!share) return new Response("Not found", { status: 404 });

    await prisma.documentShare.delete({ where: { id: shareId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "document.unshare",
      entity: "Document",
      entityId: docId,
      metadata: { sharedWith: share.userId, projectId: doc.projectId },
    });

    return success({ id: shareId });
  } catch (e) {
    return handleApiError(e);
  }
}
