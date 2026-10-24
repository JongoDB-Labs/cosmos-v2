import { Permission, hasPermission } from "@/lib/rbac/permissions";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { noContent, handleApiError } from "@/lib/api-helpers";
import { canSeeChannelGiven, loadChannelAndMembership } from "@/lib/chat/access";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";

type RouteParams = { params: Promise<{ orgId: string; channelId: string; messageId: string }> };

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId, messageId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Chat writes need CHAT_USE, as the Chat page itself does. An API key never
    // holds it (no scope grants it), so a key can't unpin messages.
    if (!hasPermission(ctx.permissions, Permission.CHAT_USE)) {
      return new Response("Forbidden", { status: 403 });
    }
    const { channel, member } = await loadChannelAndMembership(channelId, ctx.userId);
    if (!channel || channel.orgId !== orgId) return new Response("Not found", { status: 404 });
    if (!member || !canSeeChannelGiven({ channel, member, viewerOrgId: orgId, orgRole: ctx.orgRole })) {
      return new Response("Forbidden", { status: 403 });
    }
    await prisma.chatPinnedMessage.delete({ where: { channelId_messageId: { channelId, messageId } } }).catch(() => {});
    void getBus().publish(topics.channel(channelId), "chat.pin.removed", { channelId, messageId });
    return noContent();
  } catch (e) {
    return handleApiError(e);
  }
}
