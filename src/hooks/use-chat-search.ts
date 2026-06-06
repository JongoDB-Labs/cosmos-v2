"use client";
import { useQuery } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";

export type ChatSearchHit = {
  messageId: string;
  channelId: string;
  channelName: string | null;
  channelKind: "CHANNEL" | "DM" | "GROUP_DM";
  authorId: string;
  snippet: string;
  rank: number;
  createdAt: string;
};

export function useChatSearch(orgId: string, query: string, channelId?: string) {
  const key = useOrgQueryKey("chat-search", query, channelId ?? "_");
  return useQuery({
    queryKey: key,
    enabled: query.trim().length >= 2,
    queryFn: async () => {
      const params = new URLSearchParams({ q: query });
      if (channelId) params.set("channelId", channelId);
      const r = await fetch(
        `/api/v1/orgs/${orgId}/chat/search?${params.toString()}`,
      );
      if (!r.ok) throw new Error("search failed");
      const j = await r.json();
      return (j.hits ?? []) as ChatSearchHit[];
    },
  });
}
