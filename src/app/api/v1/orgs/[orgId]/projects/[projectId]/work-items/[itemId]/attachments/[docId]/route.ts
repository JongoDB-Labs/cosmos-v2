import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { requireAccess } from "@/lib/abac/require-access";
import { success, handleApiError } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { readableProjectDocument } from "@/lib/files/access";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; itemId: string; docId: string }>;
};

/**
 * DELETE — take a file off this item. It DETACHES; it does not destroy.
 *
 * The file stays in the project's library, which is the only behaviour that cannot
 * lose somebody's work by accident: a wrong attachment and an unwanted file are
 * different mistakes, and the second one already has its own route
 * (`projects/:id/documents/:docId`, which removes the bytes and needs the stronger
 * project right). Detaching needs only ITEM_UPDATE, the same right as attaching.
 */
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId, docId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectVisible(ctx, projectId);

    const item = await prisma.workItem.findFirst({
      where: { id: itemId, orgId, projectId },
      select: { id: true, createdById: true, assigneeId: true, ticketNumber: true },
    });
    if (!item) return new Response("Not found", { status: 404 });

    await requireAccess(ctx, "ITEM_UPDATE", {
      createdById: item.createdById,
      assigneeId: item.assigneeId,
      projectId,
    });

    // Scoped on workItemId as well as id: a docId that belongs to another item (or
    // to no item) is not found here rather than silently detached.
    // A file this caller may not see is not on their copy of the ticket, so it
    // is not theirs to take off it either; the same 404 as a missing one.
    if (!(await readableProjectDocument(orgId, projectId, docId, ctx)))
      return new Response("Not found", { status: 404 });
    const doc = await prisma.document.findFirst({
      where: { id: docId, orgId, workItemId: itemId },
      select: { id: true, filename: true },
    });
    if (!doc) return new Response("Not found", { status: 404 });

    await prisma.document.update({ where: { id: docId }, data: { workItemId: null } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "document.detach",
      entity: "Document",
      entityId: docId,
      metadata: {
        filename: doc.filename,
        projectId,
        workItemId: itemId,
        ticketNumber: item.ticketNumber,
        // Said explicitly so an auditor reading this entry does not have to infer
        // that the bytes survived.
        kept: "project library",
      },
    });

    return success({ detached: true, keptInProjectLibrary: true });
  } catch (e) {
    return handleApiError(e);
  }
}
