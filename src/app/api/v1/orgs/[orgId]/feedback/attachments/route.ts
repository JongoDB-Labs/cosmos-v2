import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { created, handleApiError } from "@/lib/api-helpers";
import { getStorage } from "@/lib/storage";
import { fileTypeFromBuffer } from "file-type";

type RouteParams = { params: Promise<{ orgId: string }> };

// Screenshots lean small; cap tighter than chat (25 MB) and allow images + PDF.
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const MIME_WHITELIST = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

/**
 * Upload a feedback screenshot/file. Cloned from chat attachments: magic-byte
 * sniff + MIME whitelist, stored via the storage adapter, served through an
 * auth-checked route (not the raw URL). Row is orphaned until the feedback POST
 * associates it; probabilistic GC sweeps stale orphans. Any org member may
 * attach (same gate as submitting feedback: ORG_READ).
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const formData = await req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return new Response(JSON.stringify({ error: "missing_file" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (file.size > MAX_BYTES) {
      return new Response(
        JSON.stringify({ error: "too_large", maxBytes: MAX_BYTES }),
        { status: 413, headers: { "content-type": "application/json" } },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const sniffed = await fileTypeFromBuffer(buffer);
    const contentType = sniffed?.mime ?? file.type ?? "application/octet-stream";
    if (!MIME_WHITELIST.has(contentType)) {
      return new Response(
        JSON.stringify({ error: "unsupported_mime", contentType }),
        { status: 415, headers: { "content-type": "application/json" } },
      );
    }

    const kind = contentType.startsWith("image/") ? "image" : "file";
    const attachmentId = crypto.randomUUID();
    const safeName =
      file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
    const storageKey = `${orgId}/feedback/${attachmentId}/${safeName}`;

    await getStorage().put(storageKey, buffer, { contentType, filename: file.name });

    const row = await prisma.feedbackAttachment.create({
      data: {
        id: attachmentId,
        feedbackItemId: null, // orphan until the feedback POST links it
        orgId,
        kind,
        url: `/api/v1/orgs/${orgId}/feedback/attachments/${attachmentId}`,
        storageKey,
        filename: file.name,
        contentType,
        size: file.size,
        uploadedById: ctx.userId,
      },
    });

    // Probabilistic lazy GC: sweep stale orphans (>24h, never associated).
    if (Math.random() < 1 / 50) {
      const cutoff = new Date(Date.now() - 24 * 3600_000);
      const stale = await prisma.feedbackAttachment.findMany({
        where: { feedbackItemId: null, createdAt: { lt: cutoff } },
        take: 25,
        select: { id: true, storageKey: true },
      });
      for (const s of stale) {
        await getStorage().delete(s.storageKey).catch(() => {});
        await prisma.feedbackAttachment.delete({ where: { id: s.id } }).catch(() => {});
      }
    }

    return created(row);
  } catch (e) {
    return handleApiError(e);
  }
}
