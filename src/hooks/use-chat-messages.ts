"use client";
import { useQuery } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";

export type ChatMessageReactionDto = {
  userId: string;
  emoji: string;
};

export type ChatMessageAttachmentDto = {
  id: string;
  kind: string; // "image" | "file"
  url: string;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
};

export type ChatMessageDto = {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  kind: "USER" | "ACTION" | "SYSTEM" | "ASSISTANT";
  parentMessageId: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  reactions: ChatMessageReactionDto[];
  attachments: ChatMessageAttachmentDto[];
  replyCount: number;
};

export function useChatMessages(orgId: string, channelId: string) {
  const key = useOrgQueryKey("chat-messages", channelId);
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(
        `/api/v1/orgs/${orgId}/chat/channels/${channelId}/messages?limit=50`,
      );
      if (!r.ok) throw new Error("Failed to load messages");
      const j = await r.json();
      return (j.messages ?? []) as ChatMessageDto[];
    },
  });
}
