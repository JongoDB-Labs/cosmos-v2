import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { canManageChannelGiven, canSeeChannelGiven, loadChannelAndMembership } from "@/lib/chat/access";
import { postServerMessage } from "@/lib/chat/system-message";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { parseMentions } from "@/lib/chat/mentions";
import { z } from "zod";
import { createUserMessage } from "@/lib/chat/messages";
import { runChatBot } from "@/lib/chat/bot-runner";

type RouteParams = { params: Promise<{ orgId: string; channelId: string }> };
const schema = z.object({ command: z.string().min(1).max(20), args: z.string().max(8000).default("") });

function err(error: string, status = 400) {
  return new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const limited = checkRateLimit(req, "chat.command", ctx.userId, { capacity: 20, refillPerSecond: 0.5 });
    if (limited) return limited;

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return err("invalid_input");
    const { command, args } = parsed.data;

    const { channel, member } = await loadChannelAndMembership(channelId, ctx.userId);
    if (!channel || channel.orgId !== orgId) return new Response("Not found", { status: 404 });
    if (!canSeeChannelGiven({ channel, member, viewerOrgId: orgId, orgRole: ctx.orgRole })) {
      return new Response("Not found", { status: 404 });
    }
    if (!member) return err("not_a_member", 403);

    const channelLite = { id: channel.id, kind: channel.kind, name: channel.name, orgId };
    const actorName =
      (await prisma.user.findUnique({ where: { id: ctx.userId }, select: { displayName: true } }))?.displayName ?? "Someone";

    switch (command) {
      case "topic": {
        if (!canManageChannelGiven({ channel, member, viewerOrgId: orgId, orgRole: ctx.orgRole })) return err("forbidden", 403);
        const topic = args.slice(0, 256);
        await prisma.chatChannel.update({ where: { id: channelId }, data: { topic } });
        await postServerMessage({ orgSlug: org.slug, channel: channelLite, kind: "SYSTEM", authorId: ctx.userId, content: `${actorName} set the topic to "${topic}"` });
        return success({ ok: true });
      }
      case "invite": {
        if (!canManageChannelGiven({ channel, member, viewerOrgId: orgId, orgRole: ctx.orgRole })) return err("forbidden", 403);
        const ids = parseMentions(args);
        if (ids.length === 0) return err("no_user");
        const present = await prisma.orgMember.findMany({ where: { orgId, userId: { in: ids } }, select: { userId: true } });
        if (present.length === 0) return err("user_not_in_org");
        await prisma.chatChannelMember.createMany({
          data: present.map((p) => ({ channelId, userId: p.userId, role: "MEMBER" as const })),
          skipDuplicates: true,
        });
        for (const p of present) {
          void getBus().publish(topics.user(p.userId), "chat.channel.joined", { channelId });
        }
        const names = await prisma.user.findMany({ where: { id: { in: present.map((p) => p.userId) } }, select: { displayName: true } });
        await postServerMessage({ orgSlug: org.slug, channel: channelLite, kind: "SYSTEM", authorId: ctx.userId, content: `${actorName} added ${names.map((n) => n.displayName).join(", ")} to the channel` });
        return success({ ok: true });
      }
      case "leave": {
        if (channel.isGeneral) return err("cannot_leave_general");
        if (channel.kind !== "CHANNEL") return err("cannot_leave_dm");
        await prisma.chatChannelMember.delete({ where: { channelId_userId: { channelId, userId: ctx.userId } } }).catch(() => {});
        void getBus().publish(topics.user(ctx.userId), "chat.channel.left", { channelId });
        await postServerMessage({ orgSlug: org.slug, channel: channelLite, kind: "SYSTEM", authorId: ctx.userId, content: `${actorName} left the channel` });
        return success({ ok: true, left: true });
      }
      case "mute": {
        await prisma.chatChannelMember.update({ where: { channelId_userId: { channelId, userId: ctx.userId } }, data: { notificationPref: "MUTED" } }).catch(() => {});
        return success({ ok: true, toast: `Muted #${channel.name ?? "channel"}` });
      }
      case "ai": {
        requirePermission(ctx, Permission.CHAT_USE);
        const prompt = args.trim();
        if (!prompt) return err("empty_prompt");
        const aiLimited = checkRateLimit(req, "chat.ai", ctx.userId, { capacity: 5, refillPerSecond: 0.0833 });
        if (aiLimited) return aiLimited;

        // Post the prompt as a visible USER message, then run the assistant bot
        // DETACHED (full tool + MCP agent loop) — it posts its reply when done.
        await createUserMessage({
          id: crypto.randomUUID(),
          orgSlug: org.slug,
          channel: channelLite,
          authorId: ctx.userId,
          content: prompt,
        });
        void runChatBot({
          bot: "assistant",
          orgId,
          orgSlug: org.slug,
          channelId,
          invokerUserId: ctx.userId,
          prompt,
        }).catch(() => {});
        return success({ ok: true });
      }
      case "notes": {
        requirePermission(ctx, Permission.CHAT_USE);
        const aiLimited = checkRateLimit(req, "chat.ai", ctx.userId, { capacity: 5, refillPerSecond: 0.0833 });
        if (aiLimited) return aiLimited;
        await postServerMessage({
          orgSlug: org.slug,
          channel: channelLite,
          kind: "SYSTEM",
          authorId: ctx.userId,
          content: `${actorName} asked the note-taker to summarize recent messages…`,
        });
        void runChatBot({
          bot: "notetaker",
          orgId,
          orgSlug: org.slug,
          channelId,
          invokerUserId: ctx.userId,
        }).catch(() => {});
        return success({ ok: true });
      }
      default:
        return err("unknown_command");
    }
  } catch (e) {
    return handleApiError(e);
  }
}
