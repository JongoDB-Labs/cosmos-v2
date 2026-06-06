import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { canManageChannelGiven, loadChannelAndMembership } from "@/lib/chat/access";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";
import { z } from "zod";

type RouteParams = { params: Promise<{ orgId: string; channelId: string }> };

const addSchema = z.object({ userIds: z.array(z.string().uuid()).min(1).max(50) });

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const { channel, member } = await loadChannelAndMembership(channelId, ctx.userId);
    if (!channel || channel.orgId !== orgId) return new Response("Not found", { status: 404 });
    if (!canManageChannelGiven({ channel, member, viewerOrgId: orgId, orgRole: ctx.orgRole })) {
      return new Response("Forbidden", { status: 403 });
    }

    const parsed = addSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return new Response("Bad Request", { status: 400 });

    const present = await prisma.orgMember.count({
      where: { orgId, userId: { in: parsed.data.userIds } },
    });
    if (present !== parsed.data.userIds.length) {
      return new Response(JSON.stringify({ error: "members_not_in_org" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    await prisma.chatChannelMember.createMany({
      data: parsed.data.userIds.map((userId) => ({ channelId, userId, role: "MEMBER" as const })),
      skipDuplicates: true,
    });

    for (const userId of parsed.data.userIds) {
      void getBus().publish(topics.user(userId), "chat.channel.joined", { channelId });
    }
    return success({ ok: true });
  } catch (e) {
    return handleApiError(e);
  }
}
