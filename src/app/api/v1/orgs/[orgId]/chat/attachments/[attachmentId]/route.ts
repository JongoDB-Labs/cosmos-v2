import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { handleApiError } from "@/lib/api-helpers";
import { canSeeChannelGiven, loadChannelAndMembership } from "@/lib/chat/access";
import { getStorage } from "@/lib/storage";
import { contentDisposition } from "@/lib/http/content-disposition";
import { dispositionFor } from "@/lib/storage/upload-policy";

type RouteParams = { params: Promise<{ orgId: string; attachmentId: string }> };

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, attachmentId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const att = await prisma.chatMessageAttachment.findUnique({
      where: { id: attachmentId },
      select: {
        id: true,
        storageKey: true,
        contentType: true,
        filename: true,
        size: true,
        uploadedById: true,
        message: { select: { channelId: true } },
      },
    });
    if (!att) return new Response("Not found", { status: 404 });

    // Visibility:
    //  - Attached to a message → must see that channel
    //  - Orphan → only the uploader can fetch (during compose)
    if (att.message?.channelId) {
      const { channel, member } = await loadChannelAndMembership(att.message.channelId, ctx.userId);
      if (!channel || channel.orgId !== orgId) {
        return new Response("Not found", { status: 404 });
      }
      if (!canSeeChannelGiven({ channel, member, viewerOrgId: orgId, orgRole: ctx.orgRole })) {
        return new Response("Not found", { status: 404 });
      }
    } else if (att.uploadedById !== ctx.userId) {
      return new Response("Not found", { status: 404 });
    }

    const stream = await getStorage().stream(att.storageKey);
    if (!stream) return new Response("Not found", { status: 404 });

    return new Response(stream, {
      headers: {
        "Content-Type": att.contentType,
        "Content-Length": String(att.size),
        "Content-Disposition": contentDisposition(att.filename, dispositionFor(att.contentType)),
        // Neither attachment route set this. Without it a browser may sniff the
        // bytes and render them as something other than the declared type —
        // which is stored XSS on this origin for any type we cannot verify by
        // magic bytes. `dispositionFor` downloads those rather than rendering
        // them; this stops the browser second-guessing either way.
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
