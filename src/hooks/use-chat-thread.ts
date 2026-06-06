"use client";
import { useQuery } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import type { ChatMessageDto } from "./use-chat-messages";

export function useChatThread(
  orgId: string,
  channelId: string,
  parentMessageId: string | null,
) {
  const key = useOrgQueryKey("chat-thread", channelId, parentMessageId ?? "_");
  return useQuery({
    queryKey: key,
    enabled: !!parentMessageId,
    queryFn: async () => {
      const r = await fetch(
        `/api/v1/orgs/${orgId}/chat/channels/${channelId}/messages/${parentMessageId}/replies?limit=100`,
      );
      if (!r.ok) throw new Error("Failed to load thread");
      const j = await r.json();
      return (j.replies ?? []) as ChatMessageDto[];
    },
  });
}
