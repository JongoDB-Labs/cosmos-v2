import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { noContent, handleApiError } from "@/lib/api-helpers";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";

type RouteParams = { params: Promise<{ orgId: string; channelId: string }> };

export async function POST(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const channel = await prisma.chatChannel.findUnique({
      where: { id: channelId },
      select: { isGeneral: true, kind: true, orgId: true },
    });
    if (!channel || channel.orgId !== orgId) return new Response("Not found", { status: 404 });
    if (channel.isGeneral) {
      return new Response(JSON.stringify({ error: "cannot_leave_general" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (channel.kind !== "CHANNEL") {
      return new Response(JSON.stringify({ error: "cannot_leave_dm" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    await prisma.chatChannelMember
      .delete({ where: { channelId_userId: { channelId, userId: ctx.userId } } })
      .catch(() => {
        /* already not a member */
      });

    void getBus().publish(topics.user(ctx.userId), "chat.channel.left", { channelId });
    return noContent();
  } catch (e) {
    return handleApiError(e);
  }
}
