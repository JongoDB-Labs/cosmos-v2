import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { requirePermission } from "@/lib/rbac/check";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { getStorage } from "@/lib/storage";
import { logAudit } from "@/lib/audit";
import { readableDocument, readableProjectDocument, canManageDocument, DOCUMENT_READ } from "@/lib/files/access";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; docId: string }>;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, docId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // The file's own rule decides, and it asks the project too: a restricted
    // file is hidden from the rest of its project, and one shared with somebody
    // opens for them here as on the org library, even from outside a
    // team-scoped project. When it does not open, somebody who cannot read the
    // project gets the project's refusal, as before; a reader of the project
    // gets the same 404 as for a file that does not exist.
    if (!(await readableProjectDocument(orgId, projectId, docId, ctx))) {
      await requireProjectRead(ctx, projectId, DOCUMENT_READ);
      return new Response("Not found", { status: 404 });
    }

    const doc = await prisma.document.findFirst({
      where: { id: docId, orgId, projectId },
      include: { blocks: { orderBy: { ordinal: "asc" } } },
    });
    if (!doc) return new Response("Not found", { status: 404 });
    return success(doc);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, docId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // The uploader's own file needs no bit, so a key of any scope (`read`,
    // `rules:run`) would pass as its owner. A key needs the power that uploads
    // a file here (PROJECT_UPDATE: items:write, planning:write, documents:write).
    if (ctx.isApiKey) requirePermission(ctx, Permission.PROJECT_UPDATE);
    // Who may delete is one policy, in one module, shared with the org-level
    // route and the attachment list — not PROJECT_UPDATE spelled out again here.
    // The widening that matters: the person who UPLOADED a file may take it back
    // out without finding a project manager, which is the point of recording who
    // uploaded it.
    const policyDoc = await readableDocument(orgId, docId, ctx);
    if (!policyDoc || policyDoc.projectId !== projectId)
      return new Response("Not found", { status: 404 });
    if (!(await canManageDocument(policyDoc, ctx)))
      return new Response("You did not upload this file and cannot delete it", { status: 403 });

    // Everything the audit entry needs is read BEFORE the delete, because
    // afterwards there is nothing left to read: a record saying only that an id was
    // removed cannot answer which file it was, and that is the question somebody
    // asks later.
    const doc = await prisma.document.findFirst({
      where: { id: docId, orgId, projectId },
      select: {
        id: true,
        storageKey: true,
        filename: true,
        size: true,
        contentType: true,
        uploadedById: true,
        workItemId: true,
        createdAt: true,
      },
    });
    if (!doc) return new Response("Not found", { status: 404 });
    await getStorage().delete(doc.storageKey).catch(() => {});
    await prisma.document.delete({ where: { id: doc.id } });
    // Comments hang off the document polymorphically, so nothing cascades them.
    await prisma.comment.deleteMany({
      where: { orgId, subjectType: "document", subjectId: docId },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "document.delete",
      entity: "Document",
      entityId: doc.id,
      metadata: {
        filename: doc.filename,
        size: doc.size,
        contentType: doc.contentType,
        projectId,
        // Who put it there and when, kept alongside who took it away: a deletion is
        // only legible next to the upload it undoes.
        uploadedById: doc.uploadedById,
        uploadedAt: doc.createdAt.toISOString(),
        wasAttachedToWorkItemId: doc.workItemId,
        asOwner: doc.uploadedById === ctx.userId,
      },
    });

    return success({ id: doc.id });
  } catch (e) {
    return handleApiError(e);
  }
}
