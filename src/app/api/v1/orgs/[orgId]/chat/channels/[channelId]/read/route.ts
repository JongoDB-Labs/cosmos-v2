import { Permission, hasPermission } from "@/lib/rbac/permissions";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";
import { z } from "zod";

type RouteParams = { params: Promise<{ orgId: string; channelId: string }> };

const schema = z.object({ messageId: z.string().uuid() });

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Chat writes need CHAT_USE, as the Chat page itself does. An API key never
    // holds it (no scope grants it), so a key can't mark channels read.
    if (!hasPermission(ctx.permissions, Permission.CHAT_USE)) {
      return new Response("Forbidden", { status: 403 });
    }

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return new Response("Bad Request", { status: 400 });

    // Verify channel belongs to this org before letting the user mark-read.
    const channel = await prisma.chatChannel.findUnique({
      where: { id: channelId },
      select: { orgId: true },
    });
    if (!channel || channel.orgId !== orgId) return new Response("Not found", { status: 404 });

    // Only a member has a read position. A non-member is a 404 and nothing is
    // broadcast: the receipt below would otherwise show them in the channel.
    const marked = await prisma.chatChannelMember.updateMany({
      where: { channelId, userId: ctx.userId },
      data: { lastReadMessageId: parsed.data.messageId, lastReadAt: new Date() },
    });
    if (marked.count === 0) return new Response("Not found", { status: 404 });

    // Tell my other tabs to clear the badge for this channel too.
    void getBus().publish(topics.user(ctx.userId), "chat.read.updated", {
      channelId,
      lastReadMessageId: parsed.data.messageId,
    });

    // Broadcast to the channel so other members can render read-receipt avatars.
    void getBus().publish(topics.channel(channelId), "chat.read.receipt", {
      channelId,
      userId: ctx.userId,
      lastReadMessageId: parsed.data.messageId,
    });

    return success({ ok: true });
  } catch (e) {
    return handleApiError(e);
  }
}
