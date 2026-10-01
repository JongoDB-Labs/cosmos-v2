import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { requireAccess } from "@/lib/abac/require-access";
import { success, handleApiError } from "@/lib/api-helpers";
import { ingestDocument } from "@/lib/files/ingest";
import { isExecutableUpload } from "@/lib/files/parsers";
import { withUploaders } from "@/lib/files/uploader";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; itemId: string }> };

// Raw-bytes payload for API-key clients that cannot send multipart, matching both
// documents routes so the three intakes stay one shape.
const jsonUploadSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  dataBase64: z.string().min(1),
  title: z.string().optional(),
});

/**
 * Files attached to one work item.
 *
 * An attachment is a library document with `workItemId` set, not a separate kind of
 * record. That is the whole design: it is stored, served, parsed, searched and
 * attributed by the code every other document already goes through, and because
 * `projectId` is set too it appears in the item's project Files list without any
 * second mechanism to keep in step.
 *
 * Authorisation reads the ITEM, not the file: seeing an attachment is seeing the
 * ticket (ITEM_READ), and attaching one is changing the ticket (ITEM_UPDATE). The
 * project documents route asks for PROJECT_UPDATE because putting a file in a
 * project library is a project-level act; hanging one off a ticket you are allowed
 * to edit is not, and requiring the stronger right would stop the people who
 * actually work the tickets from attaching anything to them.
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectRead(ctx, projectId, "ITEM_READ");

    const item = await prisma.workItem.findFirst({
      where: { id: itemId, orgId, projectId },
      select: { id: true },
    });
    if (!item) return new Response("Not found", { status: 404 });

    const docs = await prisma.document.findMany({
      where: { orgId, workItemId: itemId },
      select: {
        id: true,
        title: true,
        filename: true,
        contentType: true,
        format: true,
        status: true,
        size: true,
        pageCount: true,
        classificationLevel: true,
        projectId: true,
        uploadedById: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return success(await withUploaders(docs));
  } catch (e) {
    return handleApiError(e);
  }
}

/** POST — attach a file to this item. Lands in the project library at the same time. */
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    // Read the item BEFORE authorising: the policy narrows on who created it and
    // who it is assigned to, so it cannot be evaluated without those.
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

    let filename: string;
    let contentType: string;
    let buffer: Buffer;
    let title: string | undefined;

    if (req.headers.get("content-type")?.includes("application/json")) {
      const body = jsonUploadSchema.parse(await req.json());
      filename = body.filename;
      contentType = body.contentType;
      // Rejected before decoding so a huge payload is never allocated: ~33.5 MB of
      // base64 decodes to ~25 MB, the cap ingestDocument enforces on the bytes.
      if (body.dataBase64.length > 34_000_000)
        return new Response("File exceeds 25 MB limit", { status: 413 });
      buffer = Buffer.from(body.dataBase64, "base64");
      title = body.title;
    } else {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return new Response("Missing file field", { status: 400 });
      filename = file.name;
      contentType = file.type || "application/octet-stream";
      buffer = Buffer.from(await file.arrayBuffer());
    }

    if (isExecutableUpload(filename))
      return new Response("Executable files are not accepted", { status: 400 });

    const doc = await ingestDocument({
      orgId,
      projectId,
      workItemId: itemId,
      uploadedById: ctx.userId,
      filename,
      contentType,
      buffer,
      title,
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "document.attach",
      entity: "Document",
      entityId: doc.id,
      metadata: {
        filename: doc.filename,
        size: doc.size,
        contentType: doc.contentType,
        projectId,
        workItemId: itemId,
        ticketNumber: item.ticketNumber,
      },
    });

    const [hydrated] = await withUploaders([{ ...doc, uploadedById: ctx.userId }]);
    return success(hydrated, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
