import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { created, handleApiError } from "@/lib/api-helpers";
import { getStorage } from "@/lib/storage";
import { fileTypeFromBuffer } from "file-type";

type RouteParams = { params: Promise<{ orgId: string }> };

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

const MIME_WHITELIST = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/zip",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const formData = await req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return new Response(JSON.stringify({ error: "missing_file" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (file.size > MAX_BYTES) {
      return new Response(JSON.stringify({ error: "too_large", maxBytes: MAX_BYTES }), {
        status: 413,
        headers: { "content-type": "application/json" },
      });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const sniffed = await fileTypeFromBuffer(buffer);

    // text/plain and text/csv have no magic bytes — fall back to header MIME for them.
    let contentType: string;
    if (sniffed) {
      contentType = sniffed.mime;
    } else if (file.type === "text/plain" || file.type === "text/csv") {
      contentType = file.type;
    } else {
      contentType = file.type || "application/octet-stream";
    }

    if (!MIME_WHITELIST.has(contentType)) {
      return new Response(
        JSON.stringify({ error: "unsupported_mime", contentType }),
        { status: 415, headers: { "content-type": "application/json" } },
      );
    }

    const kind = contentType.startsWith("image/") ? "image" : "file";
    const attachmentId = crypto.randomUUID();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
    const storageKey = `${orgId}/${attachmentId}/${safeName}`;

    // Write to disk via the storage adapter
    await getStorage().put(storageKey, buffer, { contentType, filename: file.name });

    // Persist row. URL points at the auth-checked serve route, NOT the raw
    // storage adapter URL — clients fetch through the API so private-channel
    // membership is enforced.
    const row = await prisma.chatMessageAttachment.create({
      data: {
        id: attachmentId,
        messageId: null, // orphan until the message POST associates it
        kind,
        url: `/api/v1/orgs/${orgId}/chat/attachments/${attachmentId}`,
        storageKey,
        filename: file.name,
        contentType,
        size: file.size,
        uploadedById: ctx.userId,
      },
    });

    // Probabilistic lazy GC: every ~50 uploads, sweep orphans older than 24h.
    if (Math.random() < 1 / 50) {
      const cutoff = new Date(Date.now() - 24 * 3600_000);
      const stale = await prisma.chatMessageAttachment.findMany({
        where: { messageId: null, createdAt: { lt: cutoff } },
        take: 25,
        select: { id: true, storageKey: true },
      });
      for (const s of stale) {
        await getStorage().delete(s.storageKey).catch(() => {});
        await prisma.chatMessageAttachment.delete({ where: { id: s.id } }).catch(() => {});
      }
    }

    return created(row);
  } catch (e) {
    return handleApiError(e);
  }
}
