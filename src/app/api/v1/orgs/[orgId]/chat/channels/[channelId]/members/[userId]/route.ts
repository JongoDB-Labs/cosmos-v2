import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { noContent, handleApiError } from "@/lib/api-helpers";
import { canManageChannelGiven, loadChannelAndMembership } from "@/lib/chat/access";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";

type RouteParams = { params: Promise<{ orgId: string; channelId: string; userId: string }> };

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId, userId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const { channel, member } = await loadChannelAndMembership(channelId, ctx.userId);
    if (!channel || channel.orgId !== orgId) return new Response("Not found", { status: 404 });
    if (!canManageChannelGiven({ channel, member, viewerOrgId: orgId, orgRole: ctx.orgRole })) {
      return new Response("Forbidden", { status: 403 });
    }
    if (channel.isGeneral) {
      return new Response(JSON.stringify({ error: "cannot_remove_from_general" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    // Last-admin protection: don't allow removing the only ADMIN if the target is one
    const removingTarget = await prisma.chatChannelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
      select: { role: true },
    });
    if (removingTarget?.role === "ADMIN") {
      const otherAdmins = await prisma.chatChannelMember.count({
        where: { channelId, role: "ADMIN", NOT: { userId } },
      });
      if (otherAdmins === 0) {
        return new Response(JSON.stringify({ error: "cannot_remove_last_admin" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
    }

    await prisma.chatChannelMember
      .delete({ where: { channelId_userId: { channelId, userId } } })
      .catch(() => {/* already not a member */});

    void getBus().publish(topics.user(userId), "chat.channel.left", { channelId });
    return noContent();
  } catch (e) {
    return handleApiError(e);
  }
}
