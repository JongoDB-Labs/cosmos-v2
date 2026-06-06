import { prisma } from "@/lib/db/client";
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

export interface PostServerMessageInput {
  orgSlug: string;
  channel: ChannelLite;
  kind: "SYSTEM" | "ASSISTANT";
  authorId: string;     // actor (SYSTEM) or requester (ASSISTANT)
  content: string;
}

/**
 * Insert a server-minted SYSTEM or ASSISTANT message and publish it. SYSTEM
 * notices skip notification fan-out entirely (ambient breadcrumbs); ASSISTANT
 * replies run the normal fan-out (unread bumps + ALL/DM notification rows).
 * Clients can never create these kinds via the messages route (§4.3).
 */
export async function postServerMessage(input: PostServerMessageInput): Promise<ChatMessage> {
  const { channel } = input;
  const message = await prisma.chatMessage.create({
    data: { channelId: channel.id, authorId: input.authorId, content: input.content, kind: input.kind },
  });
  await prisma.chatChannel.update({
    where: { id: channel.id },
    data: { lastMessageAt: message.createdAt },
  });

  void getBus().publish(topics.channel(channel.id), "chat.message.created", {
    id: message.id,
    channelId: channel.id,
    authorId: message.authorId,
    content: message.content,
    kind: message.kind,
    parentMessageId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: message.createdAt,
    reactions: [],
    attachments: [],
    replyCount: 0,
  });

  if (input.kind === "ASSISTANT") {
    // An ASSISTANT message is the BOT's reply, not the human who triggered it.
    // Notifications must read "Assistant: …" — attributing the AI's words to the
    // invoking member (via their displayName) would misrepresent who said it.
    // (authorId stays the invoker for the FK + self-notify suppression.)
    void fanOutChatMessage({
      orgId: channel.orgId,
      orgSlug: input.orgSlug,
      channelId: channel.id,
      channelKind: channel.kind,
      channelName: channel.kind === "CHANNEL" ? channel.name : null,
      messageId: message.id,
      authorId: input.authorId,
      authorDisplayName: "Assistant",
      content: message.content,
      mentionedUserIds: [],
    });
  }

  return message;
}
