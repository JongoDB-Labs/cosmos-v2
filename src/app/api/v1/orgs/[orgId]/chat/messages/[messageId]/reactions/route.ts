import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { canSeeChannelGiven, loadChannelAndMembership } from "@/lib/chat/access";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { z } from "zod";

type RouteParams = { params: Promise<{ orgId: string; messageId: string }> };
const schema = z.object({ emoji: z.string().min(1).max(48) });

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, messageId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const limited = checkRateLimit(req, "chat.reaction", ctx.userId, {
      capacity: 60,
      refillPerSecond: 1,
    });
    if (limited) return limited;

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return new Response("Bad Request", { status: 400 });

    const message = await prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        channelId: true,
        deletedAt: true,
        channel: { select: { orgId: true } },
      },
    });
    if (!message || message.channel.orgId !== orgId) {
      return new Response("Not found", { status: 404 });
    }
    if (message.deletedAt) return new Response("Gone", { status: 410 });

    const { channel, member } = await loadChannelAndMembership(message.channelId, ctx.userId);
    if (!channel) return new Response("Not found", { status: 404 });
    if (!canSeeChannelGiven({ channel, member, viewerOrgId: orgId, orgRole: ctx.orgRole })) {
      return new Response("Forbidden", { status: 403 });
    }

    await prisma.chatMessageReaction.upsert({
      where: {
        messageId_userId_emoji: {
          messageId,
          userId: ctx.userId,
          emoji: parsed.data.emoji,
        },
      },
      update: {},
      create: { messageId, userId: ctx.userId, emoji: parsed.data.emoji },
    });

    void getBus().publish(topics.channel(message.channelId), "chat.reaction.added", {
      messageId,
      userId: ctx.userId,
      emoji: parsed.data.emoji,
    });

    return success({ ok: true });
  } catch (e) {
    return handleApiError(e);
  }
}
