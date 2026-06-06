import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, noContent, handleApiError } from "@/lib/api-helpers";
import { canDeleteMessageGiven, loadChannelAndMembership } from "@/lib/chat/access";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";
import { z } from "zod";

type RouteParams = { params: Promise<{ orgId: string; messageId: string }> };

const editSchema = z.object({ content: z.string().min(1).max(8000) });

// ─── PATCH — edit own message ────────────────────────────────────────────
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, messageId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const message = await prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        channelId: true,
        authorId: true,
        deletedAt: true,
        channel: { select: { orgId: true } },
      },
    });
    if (!message || message.channel.orgId !== orgId) {
      return new Response("Not found", { status: 404 });
    }
    if (message.deletedAt) return new Response("Gone", { status: 410 });
    if (message.authorId !== ctx.userId) return new Response("Forbidden", { status: 403 });

    const parsed = editSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return new Response("Bad Request", { status: 400 });

    const now = new Date();
    const updated = await prisma.chatMessage.update({
      where: { id: messageId },
      data: { content: parsed.data.content, editedAt: now },
    });

    void getBus().publish(topics.channel(message.channelId), "chat.message.updated", {
      id: updated.id,
      channelId: updated.channelId,
      content: updated.content,
      editedAt: updated.editedAt,
    });

    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

// ─── DELETE — soft-delete (author or channel/org admin) ──────────────────
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, messageId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const message = await prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        channelId: true,
        authorId: true,
        deletedAt: true,
        channel: { select: { orgId: true } },
      },
    });
    if (!message || message.channel.orgId !== orgId) {
      return new Response("Not found", { status: 404 });
    }
    if (message.deletedAt) return noContent();

    const { channel, member } = await loadChannelAndMembership(message.channelId, ctx.userId);
    if (!channel) return new Response("Not found", { status: 404 });
    if (
      !canDeleteMessageGiven({
        authorId: message.authorId,
        viewerId: ctx.userId,
        channelMember: member,
        orgRole: ctx.orgRole,
      })
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    // Soft-delete: schema enforces content NOT NULL, so null it to "".
    await prisma.chatMessage.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), content: "" },
    });

    void getBus().publish(topics.channel(message.channelId), "chat.message.deleted", {
      id: messageId,
      channelId: message.channelId,
    });

    return noContent();
  } catch (e) {
    return handleApiError(e);
  }
}
