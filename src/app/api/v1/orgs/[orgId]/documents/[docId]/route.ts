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

import { evidenceLocked, closingProblem } from "@/lib/pm/closing-evidence.server";

const CLOSED_EVIDENCE_LOCKED_MESSAGE =
  "This file supports a closed deliverable or phase. Reopen it before taking the file off.";

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
    /** Attach as a deliverable's or a phase's supporting file (the closing rule's evidence), or null to take it off. */
    deliverableId: z.string().uuid().nullable().optional(),
    phaseId: z.string().uuid().nullable().optional(),
    /**
     * Who may see it. RESTRICTED hides it from the rest of its project; INHERIT
     * puts it back to being as visible as the place it lives. Existing grants are
     * KEPT when switching to INHERIT rather than deleted, so turning restriction
     * off and on again does not silently lose the list of people it was shared
     * with — and they are dormant meanwhile, because INHERIT does not consult them.
     */
    visibility: z.enum(["INHERIT", "RESTRICTED"]).optional(),
  })
  .refine((v) => v.title !== undefined || v.workItemId !== undefined || v.deliverableId !== undefined || v.phaseId !== undefined || v.visibility !== undefined, {
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
        uploadedById: true, visibility: true, createdAt: true, updatedAt: true,
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

    // A file with no project has no project to validate a link against, and
    // the `doc.projectId ? … : {}` spreads below degrade their lookups to the
    // whole org when it is null -- so any deliverable, phase or item in the
    // org could be attached to such a file, including ones on projects this
    // caller cannot see. The disclosure is the one the workItemId comment
    // below already describes: the attachment list on the target record would
    // surface the file to that project's readers. Refuse rather than widen.
    // Detaching (an explicit null) stays allowed; it narrows nothing.
    if (!doc.projectId && (body.workItemId || body.deliverableId || body.phaseId)) {
      return new Response(
        "This file is not on a project, so it cannot be attached to a project's items",
        { status: 400 },
      );
    }

    const data: {
      title?: string;
      workItemId?: string | null;
      deliverableId?: string | null;
      phaseId?: string | null;
      visibility?: "INHERIT" | "RESTRICTED";
    } = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.visibility !== undefined) data.visibility = body.visibility;

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

    // The closing rule: a file can join a deliverable or a phase, on this
    // document's project, and can't leave a closed one.
    const links = await prisma.document.findFirst({ where: { id: docId, orgId }, select: { deliverableId: true, phaseId: true } });
    const moving =
      (body.deliverableId !== undefined && body.deliverableId !== links?.deliverableId && links?.deliverableId) ||
      (body.phaseId !== undefined && body.phaseId !== links?.phaseId && links?.phaseId);
    if (moving && links && (await evidenceLocked(orgId, links))) {
      return closingProblem({ code: "closed_read_only", message: CLOSED_EVIDENCE_LOCKED_MESSAGE }, req);
    }
    const scope = { orgId, ...(doc.projectId ? { projectId: doc.projectId } : {}) };
    if (body.deliverableId !== undefined) {
      if (body.deliverableId === null) data.deliverableId = null;
      else {
        const d = await prisma.deliverable.findFirst({ where: { id: body.deliverableId, ...scope }, select: { id: true } });
        if (!d) return new Response("That deliverable is not on this file's project", { status: 400 });
        data.deliverableId = d.id;
      }
    }
    if (body.phaseId !== undefined) {
      if (body.phaseId === null) data.phaseId = null;
      else {
        const p = await prisma.projectPhase.findFirst({ where: { id: body.phaseId, ...scope }, select: { id: true } });
        if (!p) return new Response("That phase is not on this file's project", { status: 400 });
        data.phaseId = p.id;
      }
    }

    const updated = await prisma.document.update({
      where: { id: docId },
      data,
      select: {
        id: true, title: true, filename: true, projectId: true, workItemId: true,
        uploadedById: true, visibility: true, createdAt: true, updatedAt: true,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action:
        body.visibility !== undefined
          ? "document.visibility"
          : body.title !== undefined
            ? "document.rename"
            : "document.relink",
      entity: "Document",
      entityId: docId,
      metadata: {
        filename: updated.filename,
        ...(body.title !== undefined ? { title: updated.title } : {}),
        ...(body.workItemId !== undefined ? { workItemId: updated.workItemId } : {}),
        ...(body.deliverableId !== undefined ? { deliverableId: body.deliverableId ?? "" } : {}),
        ...(body.phaseId !== undefined ? { phaseId: body.phaseId ?? "" } : {}),
        ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
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
        uploadedById: true, workItemId: true, createdAt: true, deliverableId: true, phaseId: true,
      },
    });
    if (!full) return new Response("Not found", { status: 404 });
    // Deleting a closed record's evidence would edit it after the fact.
    if (await evidenceLocked(orgId, full)) {
      return closingProblem({ code: "closed_read_only", message: CLOSED_EVIDENCE_LOCKED_MESSAGE }, req);
    }

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
