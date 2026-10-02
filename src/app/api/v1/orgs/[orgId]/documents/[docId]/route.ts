import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { getStorage } from "@/lib/storage";
import { readableDocument, canManageDocument } from "@/lib/files/access";
import { withUploaders } from "@/lib/files/uploader";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; docId: string }> };

const patchSchema = z
  .object({
    /**
     * The display name. NOT `filename`, which is deliberately immutable: the
     * serving policy reads the extension to decide whether a file renders as
     * itself, as text, inside a sandbox, or not at all. Letting a rename change
     * the filename would let somebody move a stored file between those tiers
     * after it was uploaded, which is a privilege escalation wearing the costume
     * of a rename.
     */
    title: z.string().min(1).max(200).optional(),
    /**
     * Attach to a work item, or null to take it off one. The same act as the ×
     * on the item's own attachment list, from the other side: the Files screen
     * is where somebody is when they notice a file is on the wrong ticket.
     */
    workItemId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.title !== undefined || v.workItemId !== undefined, {
    message: "Nothing to change",
  });

/** GET — one document, with its uploader resolved. */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, docId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    if (!(await readableDocument(orgId, docId, ctx)))
      return new Response("Not found", { status: 404 });

    const doc = await prisma.document.findFirst({
      where: { id: docId, orgId },
      select: {
        id: true, orgId: true, title: true, filename: true, contentType: true,
        format: true, status: true, size: true, pageCount: true,
        classificationLevel: true, projectId: true, workItemId: true,
        uploadedById: true, createdAt: true, updatedAt: true,
        project: { select: { key: true, name: true } },
        workItem: { select: { ticketNumber: true, title: true } },
      },
    });
    if (!doc) return new Response("Not found", { status: 404 });
    const [hydrated] = await withUploaders([doc]);
    return success({ ...hydrated, canManage: await canManageDocument(doc, ctx) });
  } catch (e) {
    return handleApiError(e);
  }
}

/** PATCH — rename it, or attach/detach it from a work item. */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, docId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const doc = await readableDocument(orgId, docId, ctx);
    // 404 and not 403: somebody who cannot see a file should not learn it exists
    // by being refused permission to change it.
    if (!doc) return new Response("Not found", { status: 404 });
    if (!(await canManageDocument(doc, ctx)))
      return new Response("You did not upload this file and cannot change it", { status: 403 });

    const body = patchSchema.parse(await req.json());
    const data: { title?: string; workItemId?: string | null } = {};
    if (body.title !== undefined) data.title = body.title;

    if (body.workItemId !== undefined) {
      if (body.workItemId === null) {
        data.workItemId = null;
      } else {
        // The item must be in this org AND on this document's project. Without
        // the second half a file could be hung off a ticket on a job its reader
        // cannot see, and the attachment list on that ticket would disclose it.
        const item = await prisma.workItem.findFirst({
          where: { id: body.workItemId, orgId, ...(doc.projectId ? { projectId: doc.projectId } : {}) },
          select: { id: true, projectId: true },
        });
        if (!item)
          return new Response("That item is not on this file's project", { status: 400 });
        data.workItemId = item.id;
      }
    }

    const updated = await prisma.document.update({
      where: { id: docId },
      data,
      select: {
        id: true, title: true, filename: true, projectId: true, workItemId: true,
        uploadedById: true, createdAt: true, updatedAt: true,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: body.title !== undefined ? "document.rename" : "document.relink",
      entity: "Document",
      entityId: docId,
      metadata: {
        filename: updated.filename,
        ...(body.title !== undefined ? { title: updated.title } : {}),
        ...(body.workItemId !== undefined ? { workItemId: updated.workItemId } : {}),
        // Said plainly, because "who may change this" is the question an auditor
        // asks about a rename they did not expect.
        asOwner: doc.uploadedById === ctx.userId,
      },
    });

    const [hydrated] = await withUploaders([updated]);
    return success(hydrated);
  } catch (e) {
    return handleApiError(e);
  }
}

/** DELETE — remove the file and its bytes. The uploader may do this too. */
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, docId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const doc = await readableDocument(orgId, docId, ctx);
    if (!doc) return new Response("Not found", { status: 404 });
    if (!(await canManageDocument(doc, ctx)))
      return new Response("You did not upload this file and cannot delete it", { status: 403 });

    // Read before deleting: afterwards there is nothing left to describe, and a
    // record saying only that an id went cannot answer which file it was.
    const full = await prisma.document.findFirst({
      where: { id: docId, orgId },
      select: {
        storageKey: true, filename: true, size: true, contentType: true,
        uploadedById: true, workItemId: true, createdAt: true,
      },
    });
    if (!full) return new Response("Not found", { status: 404 });

    await getStorage().delete(full.storageKey).catch(() => {});
    await prisma.document.delete({ where: { id: docId } });
    // Comments hang off the document polymorphically, so nothing cascades them.
    await prisma.comment.deleteMany({
      where: { orgId, subjectType: "document", subjectId: docId },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "document.delete",
      entity: "Document",
      entityId: docId,
      metadata: {
        filename: full.filename,
        size: full.size,
        contentType: full.contentType,
        projectId: doc.projectId,
        uploadedById: full.uploadedById,
        uploadedAt: full.createdAt.toISOString(),
        wasAttachedToWorkItemId: full.workItemId,
        asOwner: full.uploadedById === ctx.userId,
      },
    });

    return success({ id: docId });
  } catch (e) {
    return handleApiError(e);
  }
}
