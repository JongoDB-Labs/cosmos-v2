import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";
import { z } from "zod";

type RouteParams = { params: Promise<{ orgId: string }> };

const schema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(7),
});

function makeDmKey(userIds: string[]): string {
  return [...userIds].sort().join(":");
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return new Response("Bad Request", { status: 400 });

    const otherIds = parsed.data.userIds.filter((id) => id !== ctx.userId);
    if (otherIds.length === 0) {
      return new Response(JSON.stringify({ error: "cannot_dm_yourself" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const presentCount = await prisma.orgMember.count({
      where: { orgId, userId: { in: otherIds } },
    });
    if (presentCount !== otherIds.length) {
      return new Response(JSON.stringify({ error: "user_not_in_org" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const participants = [ctx.userId, ...otherIds];
    const dmKey = makeDmKey(participants);
    const kind = otherIds.length === 1 ? ("DM" as const) : ("GROUP_DM" as const);

    const existing = await prisma.chatChannel.findFirst({
      where: { orgId, dmKey },
      select: { id: true, kind: true },
    });
    if (existing) {
      return success({ channelId: existing.id, kind: existing.kind, created: false });
    }

    const channel = await prisma.$transaction(async (tx) => {
      const c = await tx.chatChannel.create({
        data: {
          orgId,
          kind,
          dmKey,
          isPrivate: true,
          isGeneral: false,
          createdById: ctx.userId,
        },
      });
      await tx.chatChannelMember.createMany({
        data: participants.map((userId) => ({ channelId: c.id, userId, role: "MEMBER" as const })),
      });
      return c;
    });

    for (const userId of participants) {
      void getBus().publish(topics.user(userId), "chat.channel.joined", { channelId: channel.id });
    }

    return success({ channelId: channel.id, kind, created: true });
  } catch (e) {
    return handleApiError(e);
  }
}
