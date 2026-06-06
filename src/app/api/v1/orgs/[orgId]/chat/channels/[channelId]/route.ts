import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, noContent, handleApiError } from "@/lib/api-helpers";
import { canSeeChannelGiven, canManageChannelGiven, loadChannelAndMembership } from "@/lib/chat/access";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

type RouteParams = { params: Promise<{ orgId: string; channelId: string }> };

// ─── GET /channels/[channelId] ────────────────────────────────────────────
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const { channel, member } = await loadChannelAndMembership(channelId, ctx.userId);
    if (!channel) return new Response("Not found", { status: 404 });
    if (!canSeeChannelGiven({ channel, member, viewerOrgId: orgId, orgRole: ctx.orgRole })) {
      // 404, not 403 — avoid existence leaks for private channels
      return new Response("Not found", { status: 404 });
    }

    const members = await prisma.chatChannelMember.findMany({
      where: { channelId },
      select: {
        userId: true,
        role: true,
        joinedAt: true,
      },
    });
    const users = await prisma.user.findMany({
      where: { id: { in: members.map((m) => m.userId) } },
      select: { id: true, displayName: true, avatarUrl: true, email: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));

    return success({
      channel,
      members: members.map((m) => ({
        userId: m.userId,
        role: m.role,
        joinedAt: m.joinedAt,
        user: byId.get(m.userId) ?? null,
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}

// ─── PATCH /channels/[channelId] ─────────────────────────────────────────
const patchSchema = z.object({
  name: z.string().min(1).max(32).optional(),
  description: z.string().max(512).nullable().optional(),
  topic: z.string().max(256).nullable().optional(),
  archive: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const { channel, member } = await loadChannelAndMembership(channelId, ctx.userId);
    if (!channel) return new Response("Not found", { status: 404 });
    if (!canManageChannelGiven({ channel, member, viewerOrgId: orgId, orgRole: ctx.orgRole })) {
      return new Response("Forbidden", { status: 403 });
    }

    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return new Response("Bad Request", { status: 400 });

    const { name, description, topic, archive } = parsed.data;
    if (archive && channel.isGeneral) {
      return new Response(JSON.stringify({ error: "cannot_archive_general" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const updated = await prisma.chatChannel.update({
      where: { id: channelId },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(topic !== undefined && { topic }),
        ...(archive !== undefined && { archivedAt: archive ? new Date() : null }),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: archive ? "chat.channel.archived" : "chat.channel.updated",
      entity: "chat_channel",
      entityId: channelId,
      metadata: parsed.data,
    });

    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

// ─── DELETE /channels/[channelId] — org admin / owner only ───────────────
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    if (ctx.orgRole !== "OWNER" && ctx.orgRole !== "ADMIN") {
      return new Response("Forbidden", { status: 403 });
    }
    const channel = await prisma.chatChannel.findUnique({
      where: { id: channelId },
      select: { isGeneral: true, orgId: true },
    });
    if (!channel || channel.orgId !== orgId) return new Response("Not found", { status: 404 });
    if (channel.isGeneral) {
      return new Response(JSON.stringify({ error: "cannot_delete_general" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    await prisma.chatChannel.delete({ where: { id: channelId } });
    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "chat.channel.deleted",
      entity: "chat_channel",
      entityId: channelId,
    });
    return noContent();
  } catch (e) {
    return handleApiError(e);
  }
}
