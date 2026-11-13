"use client";
import { useQuery } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import { ChatForbiddenError } from "@/lib/chat/chat-forbidden";

export type ChatChannelSummary = {
  id: string;
  kind: "CHANNEL" | "DM" | "GROUP_DM";
  name: string | null;
  slug: string | null;
  description: string | null;
  topic: string | null;
  isPrivate: boolean;
  isGeneral: boolean;
  /** Viewer may rename / set topic / archive this channel (org or channel admin). */
  canManage: boolean;
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
    retry: (failures, error) => !(error instanceof ChatForbiddenError) && failures < 1,
    queryFn: async () => {
      const r = await fetch(`/api/v1/orgs/${orgId}/chat/channels`);
      if (r.status === 403) throw new ChatForbiddenError();
      if (!r.ok) throw new Error("Failed to load channels");
      // success() in api-helpers.ts calls NextResponse.json(data) with no
      // wrapping — the route passes { channels } directly so json.channels
      // is the array.
      const json = await r.json();
      return json.channels as ChatChannelSummary[];
    },
  });
}
