import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { readableDocument, canManageDocument } from "@/lib/files/access";

type RouteParams = { params: Promise<{ orgId: string; docId: string; commentId: string }> };

/**
 * DELETE — remove one comment on a file.
 *
 * The author may remove their own. Somebody who may manage the FILE may remove
 * any of them, which is the same shape as every other moderation right here: the
 * person responsible for the thing is responsible for what is written on it.
 */
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, docId, commentId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const doc = await readableDocument(orgId, docId, ctx);
    if (!doc) return new Response("Not found", { status: 404 });

    // Scoped on the subject as well as the id, so a comment id belonging to a
    // different document (or to a work item) is not found here rather than
    // deleted through the wrong door.
    const comment = await prisma.comment.findFirst({
      where: { id: commentId, orgId, subjectType: "document", subjectId: docId },
      select: { id: true, authorId: true },
    });
    if (!comment) return new Response("Not found", { status: 404 });

    const mine = comment.authorId === ctx.userId;
    if (!mine && !(await canManageDocument(doc, ctx)))
      return new Response("You did not write this comment", { status: 403 });

    await prisma.comment.delete({ where: { id: commentId } });
    return success({ id: commentId });
  } catch (e) {
    return handleApiError(e);
  }
}
