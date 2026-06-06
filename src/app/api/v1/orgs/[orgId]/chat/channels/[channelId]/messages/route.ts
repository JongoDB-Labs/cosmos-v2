import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, created, handleApiError } from "@/lib/api-helpers";
import {
  canSeeChannelGiven,
  canPostToChannelGiven,
  loadChannelAndMembership,
} from "@/lib/chat/access";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { createUserMessage } from "@/lib/chat/messages";
import { runChatBot, detectBotMention } from "@/lib/chat/bot-runner";
import { hasPermission } from "@/lib/rbac/permissions";
import { Permission } from "@/lib/rbac/permissions";
import { z } from "zod";

type RouteParams = { params: Promise<{ orgId: string; channelId: string }> };

// ─── GET — paginated history (Phase 1: main feed, parentMessageId IS NULL) ───
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const { channel, member } = await loadChannelAndMembership(channelId, ctx.userId);
    if (!channel) return new Response("Not found", { status: 404 });
    if (!canSeeChannelGiven({ channel, member, viewerOrgId: orgId, orgRole: ctx.orgRole })) {
      return new Response("Not found", { status: 404 });
    }

    const url = new URL(req.url);
    const before = url.searchParams.get("before");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 100);

    const messages = await prisma.chatMessage.findMany({
      where: {
        channelId,
        parentMessageId: null,
        ...(before && { createdAt: { lt: new Date(before) } }),
      },
      orderBy: { createdAt: "desc" },
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
      messages: messages.reverse().map((m) => ({
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

// ─── POST — send a message ──────────────────────────────────────────────
const postSchema = z.object({
  id: z.string().uuid(),                          // client-generated for optimistic dedup
  content: z.string().min(1).max(8000),
  parentMessageId: z.string().uuid().nullable().optional(),
  attachmentIds: z.array(z.string().uuid()).max(10).optional(),
  kind: z.enum(["USER", "ACTION"]).optional(),    // §4.3: SYSTEM/ASSISTANT rejected here
});

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const limited = checkRateLimit(req, "chat.message.send", ctx.userId, {
      capacity: 10,
      refillPerSecond: 1,
    });
    if (limited) return limited;

    const { channel, member } = await loadChannelAndMembership(channelId, ctx.userId);
    if (!channel) return new Response("Not found", { status: 404 });
    if (!canPostToChannelGiven({ channel, member, viewerOrgId: orgId, orgRole: ctx.orgRole })) {
      return new Response("Forbidden", { status: 403 });
    }
    if (channel.archivedAt) {
      return new Response(JSON.stringify({ error: "channel_archived" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const parsed = postSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return new Response("Bad Request", { status: 400 });

    // Idempotency: client retry with same UUID gets the existing row.
    const dup = await prisma.chatMessage.findUnique({ where: { id: parsed.data.id } });
    if (dup) return created(dup);

    const message = await createUserMessage({
      id: parsed.data.id,
      orgSlug: org.slug,
      channel: { id: channel.id, kind: channel.kind, name: channel.name, orgId },
      authorId: ctx.userId,
      content: parsed.data.content,
      parentMessageId: parsed.data.parentMessageId ?? null,
      attachmentIds: parsed.data.attachmentIds,
      kind: parsed.data.kind ?? "USER",
    });

    // AI bots: a text @assistant / @notetaker / @ai mention triggers a detached
    // bot run (it posts its reply when done). Rate-limited; skipped (not
    // blocked) when over budget so the human message still posts.
    const bot = detectBotMention(parsed.data.content);
    if (bot && hasPermission(ctx.permissions, Permission.CHAT_USE)) {
      const botLimited = checkRateLimit(req, "chat.ai", ctx.userId, {
        capacity: 5,
        refillPerSecond: 0.0833,
      });
      if (!botLimited) {
        void runChatBot({
          bot,
          orgId,
          orgSlug: org.slug,
          channelId,
          invokerUserId: ctx.userId,
          prompt: parsed.data.content,
        }).catch(() => {});
      }
    }

    return created(message);
  } catch (e) {
    return handleApiError(e);
  }
}
