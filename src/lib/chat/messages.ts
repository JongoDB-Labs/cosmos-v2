import { prisma } from "@/lib/db/client";
import { parseMentions } from "@/lib/chat/mentions";
import { fanOutChatMessage } from "@/lib/chat/notifications";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";
import type { ChatMessage } from "@prisma/client";

type ChannelLite = {
  id: string;
  kind: "CHANNEL" | "DM" | "GROUP_DM";
  name: string | null;
  orgId: string;
};

export interface CreateUserMessageInput {
  id: string;                       // client-generated UUID (idempotency handled by caller)
  orgSlug: string;
  channel: ChannelLite;
  authorId: string;
  content: string;
  parentMessageId?: string | null;
  attachmentIds?: string[];
  kind?: "USER" | "ACTION";
}

/**
 * Create a user-authored chat message and run the full real-time + notification
 * fan-out. Extracted from POST /messages so the slash-command dispatcher (/ai
 * prompt) can reuse the exact same path. Caller handles auth, rate-limit,
 * access checks, archived-channel rejection, and the idempotency dup-check.
 */
export async function createUserMessage(input: CreateUserMessageInput): Promise<ChatMessage> {
  const { channel } = input;
  const orgId = channel.orgId;
  const kind = input.kind ?? "USER";

  const mentionedAll = parseMentions(input.content);
  const mentionedInOrg = mentionedAll.length
    ? await prisma.orgMember.findMany({
        where: { orgId, userId: { in: mentionedAll } },
        select: { userId: true },
      })
    : [];
  const validMentions = mentionedInOrg.map((m) => m.userId);

  const message = await prisma.$transaction(async (tx) => {
    const m = await tx.chatMessage.create({
      data: {
        id: input.id,
        channelId: channel.id,
        authorId: input.authorId,
        content: input.content,
        kind,
        parentMessageId: input.parentMessageId ?? null,
      },
    });
    if (validMentions.length) {
      await tx.chatMessageMention.createMany({
        data: validMentions.map((userId) => ({ messageId: m.id, userId })),
        skipDuplicates: true,
      });
    }
    await tx.chatChannel.update({
      where: { id: channel.id },
      data: { lastMessageAt: m.createdAt },
    });
    if (input.attachmentIds && input.attachmentIds.length > 0) {
      await tx.chatMessageAttachment.updateMany({
        where: { id: { in: input.attachmentIds }, uploadedById: input.authorId, messageId: null },
        data: { messageId: m.id },
      });
    }
    return m;
  });

  // Fetch any attachments that were just associated inside the transaction
  // so the bus payload is complete — SSE receivers don't need a refetch.
  const attachments =
    input.attachmentIds && input.attachmentIds.length > 0
      ? await prisma.chatMessageAttachment.findMany({
          where: { messageId: message.id },
          select: { id: true, kind: true, url: true, filename: true, contentType: true, size: true, width: true, height: true },
        })
      : [];

  // Real-time fan-out to the channel topic. The full ChatMessageDto shape
  // must be included — undefined editedAt/deletedAt would tombstone-render
  // on the client (MessageItem checks `deletedAt != null`).
  void getBus().publish(topics.channel(channel.id), "chat.message.created", {
    id: message.id,
    channelId: channel.id,
    authorId: message.authorId,
    content: message.content,
    kind: message.kind,
    parentMessageId: message.parentMessageId,
    editedAt: null,
    deletedAt: null,
    createdAt: message.createdAt,
    reactions: [],
    attachments,
    replyCount: 0,
  });

  // Notification fan-out per recipient's notificationPref
  const author = await prisma.user.findUnique({
    where: { id: input.authorId },
    select: { displayName: true },
  });

  void fanOutChatMessage({
    orgId,
    orgSlug: input.orgSlug,
    channelId: channel.id,
    channelKind: channel.kind,
    channelName: channel.kind === "CHANNEL" ? channel.name : null,
    messageId: message.id,
    authorId: input.authorId,
    authorDisplayName: author?.displayName ?? "Someone",
    content: message.content,
    mentionedUserIds: validMentions,
  });

  return message;
}
