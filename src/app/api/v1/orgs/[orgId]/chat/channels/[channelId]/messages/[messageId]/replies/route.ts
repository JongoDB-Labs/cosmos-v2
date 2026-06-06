import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { canSeeChannelGiven, loadChannelAndMembership } from "@/lib/chat/access";

type RouteParams = { params: Promise<{ orgId: string; channelId: string; messageId: string }> };

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId, messageId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const { channel, member } = await loadChannelAndMembership(channelId, ctx.userId);
    if (!channel) return new Response("Not found", { status: 404 });
    if (!canSeeChannelGiven({ channel, member, viewerOrgId: orgId, orgRole: ctx.orgRole })) {
      return new Response("Not found", { status: 404 });
    }

    // Confirm the parent message exists in this channel
    const parent = await prisma.chatMessage.findFirst({
      where: { id: messageId, channelId },
      select: { id: true },
    });
    if (!parent) return new Response("Not found", { status: 404 });

    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10), 200);

    const replies = await prisma.chatMessage.findMany({
      where: { parentMessageId: messageId },
      orderBy: { createdAt: "asc" },
      take: limit,
      include: {
        reactions: { select: { userId: true, emoji: true } },
        attachments: {
          select: {
            id: true,
            kind: true,
            url: true,
            filename: true,
            contentType: true,
            size: true,
            width: true,
            height: true,
          },
        },
        _count: { select: { replies: true } },
      },
    });

    return success({
      replies: replies.map((m) => ({
        id: m.id,
        channelId: m.channelId,
        authorId: m.authorId,
        content: m.content,
        kind: m.kind,
        parentMessageId: m.parentMessageId,
        editedAt: m.editedAt,
        deletedAt: m.deletedAt,
        createdAt: m.createdAt,
        reactions: m.reactions,
        attachments: m.attachments,
        replyCount: m._count.replies,
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
