"use client";
import { useQuery } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";

export type ChatChannelSummary = {
  id: string;
  kind: "CHANNEL" | "DM" | "GROUP_DM";
  name: string | null;
  slug: string | null;
  description: string | null;
  topic: string | null;
  isPrivate: boolean;
  isGeneral: boolean;
  projectId: string | null;
  lastMessageAt: string | null;
  notificationPref: "ALL" | "MENTIONS" | "MUTED";
  lastReadMessageId: string | null;
  otherParticipants: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
  }[];
};

export function useChatChannels(orgId: string) {
  const key = useOrgQueryKey("chat-channels");
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/v1/orgs/${orgId}/chat/channels`);
      if (!r.ok) throw new Error("Failed to load channels");
      // success() in api-helpers.ts calls NextResponse.json(data) with no
      // wrapping — the route passes { channels } directly so json.channels
      // is the array.
      const json = await r.json();
      return json.channels as ChatChannelSummary[];
    },
  });
}
