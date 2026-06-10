import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { noContent, handleApiError } from "@/lib/api-helpers";
import { getStorage } from "@/lib/storage";

type RouteParams = { params: Promise<{ orgId: string; attachmentId: string }> };

/**
 * Serve (GET) or delete (DELETE) a feedback attachment. Org-isolated:
 * - GET: any org member may view an associated attachment (feedback is org-wide
 *   visible); an orphan is only fetchable by its uploader (compose preview).
 * - DELETE: the uploader OR an admin (ORG_UPDATE) — for moderation.
 */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, attachmentId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const att = await prisma.feedbackAttachment.findUnique({
      where: { id: attachmentId },
      select: {
        storageKey: true,
        contentType: true,
        filename: true,
        size: true,
        uploadedById: true,
        orgId: true,
        feedbackItemId: true,
      },
    });
    if (!att || att.orgId !== orgId) return new Response("Not found", { status: 404 });

    // Associated → any org member may view (feedback is org-visible). Orphan →
    // only the uploader (during compose).
    if (!att.feedbackItemId && att.uploadedById !== ctx.userId) {
      return new Response("Not found", { status: 404 });
    }

    const stream = await getStorage().stream(att.storageKey);
    if (!stream) return new Response("Not found", { status: 404 });

    return new Response(stream, {
      headers: {
        "Content-Type": att.contentType,
        "Content-Length": String(att.size),
        "Content-Disposition": `inline; filename="${encodeURIComponent(att.filename)}"`,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, attachmentId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const att = await prisma.feedbackAttachment.findUnique({
      where: { id: attachmentId },
      select: { id: true, orgId: true, storageKey: true, uploadedById: true },
    });
    if (!att || att.orgId !== orgId) return new Response("Not found", { status: 404 });

    const allowed =
      att.uploadedById === ctx.userId ||
      hasPermission(ctx.permissions, Permission.ORG_UPDATE);
    if (!allowed) return new Response("Forbidden", { status: 403 });

    await getStorage().delete(att.storageKey).catch(() => {});
    await prisma.feedbackAttachment.delete({ where: { id: att.id } });
    return noContent();
  } catch (e) {
    return handleApiError(e);
  }
}
