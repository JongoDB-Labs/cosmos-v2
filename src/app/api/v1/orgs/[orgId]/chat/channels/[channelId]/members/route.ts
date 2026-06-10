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

/** GET — list this channel's members (any member of the channel may read). */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const { channel, member } = await loadChannelAndMembership(channelId, ctx.userId);
    if (!channel || channel.orgId !== orgId) return new Response("Not found", { status: 404 });
    // Only members (or org owners/admins) can see the roster.
    const isOrgAdmin = ctx.orgRole === "OWNER" || ctx.orgRole === "ADMIN";
    if (!member && !isOrgAdmin) return new Response("Forbidden", { status: 403 });

    // ChatChannelMember has no `user` relation (userId is a raw column), so
    // batch-fetch the display names separately (same pattern as the channels
    // list route).
    const members = await prisma.chatChannelMember.findMany({
      where: { channelId },
      select: { userId: true, role: true },
    });
    const users = members.length
      ? await prisma.user.findMany({
          where: { id: { in: members.map((m) => m.userId) } },
          select: { id: true, displayName: true, avatarUrl: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));

    return success(
      members
        .map((m) => ({
          userId: m.userId,
          role: m.role,
          displayName: byId.get(m.userId)?.displayName ?? "User",
          avatarUrl: byId.get(m.userId)?.avatarUrl ?? null,
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    );
  } catch (e) {
    return handleApiError(e);
  }
}

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
