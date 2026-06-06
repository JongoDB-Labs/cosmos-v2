import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, created, handleApiError } from "@/lib/api-helpers";
import { canSeeChannelGiven, canPostToChannelGiven, loadChannelAndMembership } from "@/lib/chat/access";
import { postServerMessage } from "@/lib/chat/system-message";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";
import { z } from "zod";

type RouteParams = { params: Promise<{ orgId: string; channelId: string }> };
const PIN_CAP = 50;

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    const { channel, member } = await loadChannelAndMembership(channelId, ctx.userId);
    if (!channel || channel.orgId !== orgId) return new Response("Not found", { status: 404 });
    if (!canSeeChannelGiven({ channel, member, viewerOrgId: orgId, orgRole: ctx.orgRole })) {
      return new Response("Not found", { status: 404 });
    }

    const pins = await prisma.chatPinnedMessage.findMany({
      where: { channelId },
      orderBy: { pinnedAt: "desc" },
      include: {
        message: {
          select: {
            id: true, channelId: true, authorId: true, content: true, kind: true,
            parentMessageId: true, editedAt: true, deletedAt: true, createdAt: true,
          },
        },
      },
    });

    return success({
      pins: pins.map((p) => ({
        pinnedById: p.pinnedById,
        pinnedAt: p.pinnedAt,
        message: { ...p.message, reactions: [], attachments: [], replyCount: 0 },
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}

const postSchema = z.object({ messageId: z.string().uuid() });

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    const { channel, member } = await loadChannelAndMembership(channelId, ctx.userId);
    if (!channel || channel.orgId !== orgId) return new Response("Not found", { status: 404 });
    if (!canPostToChannelGiven({ channel, member, viewerOrgId: orgId, orgRole: ctx.orgRole })) {
      return new Response("Forbidden", { status: 403 });
    }
    const parsed = postSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return new Response("Bad Request", { status: 400 });

    const msg = await prisma.chatMessage.findFirst({
      where: { id: parsed.data.messageId, channelId },
      select: { id: true, deletedAt: true },
    });
    if (!msg) return new Response("Not found", { status: 404 });
    if (msg.deletedAt) return new Response("Gone", { status: 410 });

    const existing = await prisma.chatPinnedMessage.findUnique({
      where: { channelId_messageId: { channelId, messageId: msg.id } },
    });
    if (existing) return success({ ok: true, already: true });

    const count = await prisma.chatPinnedMessage.count({ where: { channelId } });
    if (count >= PIN_CAP) {
      return new Response(JSON.stringify({ error: "pin_limit_reached", cap: PIN_CAP }), {
        status: 409, headers: { "content-type": "application/json" },
      });
    }

    await prisma.chatPinnedMessage.create({ data: { channelId, messageId: msg.id, pinnedById: ctx.userId } });
    void getBus().publish(topics.channel(channelId), "chat.pin.added", { channelId, messageId: msg.id, pinnedById: ctx.userId });

    const actorName = (await prisma.user.findUnique({ where: { id: ctx.userId }, select: { displayName: true } }))?.displayName ?? "Someone";
    await postServerMessage({
      orgSlug: org.slug,
      channel: { id: channel.id, kind: channel.kind, name: channel.name, orgId },
      kind: "SYSTEM",
      authorId: ctx.userId,
      content: `📌 ${actorName} pinned a message`,
    });

    return created({ ok: true });
  } catch (e) {
    return handleApiError(e);
  }
}
