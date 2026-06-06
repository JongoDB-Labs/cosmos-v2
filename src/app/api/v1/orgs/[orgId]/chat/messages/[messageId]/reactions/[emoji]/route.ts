import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { noContent, handleApiError } from "@/lib/api-helpers";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";

type RouteParams = { params: Promise<{ orgId: string; messageId: string; emoji: string }> };

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, messageId, emoji: rawEmoji } = await params;
    const emoji = decodeURIComponent(rawEmoji);
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const message = await prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { channelId: true, channel: { select: { orgId: true } } },
    });
    if (!message || message.channel.orgId !== orgId) {
      return new Response("Not found", { status: 404 });
    }

    await prisma.chatMessageReaction
      .delete({
        where: {
          messageId_userId_emoji: {
            messageId,
            userId: ctx.userId,
            emoji,
          },
        },
      })
      .catch(() => {
        /* already removed; idempotent */
      });

    void getBus().publish(topics.channel(message.channelId), "chat.reaction.removed", {
      messageId,
      userId: ctx.userId,
      emoji,
    });

    return noContent();
  } catch (e) {
    return handleApiError(e);
  }
}
