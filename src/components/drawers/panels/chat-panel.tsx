"use client";

import { useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import {
  useChatChannels,
  type ChatChannelSummary,
} from "@/hooks/use-chat-channels";
import { ChatSidebar } from "@/components/chat/chat-sidebar";
import { ChannelView } from "@/components/chat/channel-view";

interface ChatPanelProps {
  orgId: string;
  orgSlug: string;
  userId: string;
}

/**
 * Chat drawer tool. Master/detail: the SAME full `ChatSidebar` as the /chat
 * page (project-grouped channels, DMs + presence, search, create/browse-channel
 * and new-DM dialogs) wired with `onSelectChannel` so picking a channel opens
 * it IN PLACE (no page navigation behind the drawer), then the full live
 * `ChannelView` (messages, composer, threads, reactions, pins). The DockedDrawer
 * frame supplies the tool tabs, resize, and close.
 */
export function ChatPanel({ orgId, userId }: ChatPanelProps) {
  const { data } = useChatChannels(orgId);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = useMemo(
    () => (data ?? []).find((c) => c.id === selectedId) ?? null,
    [data, selectedId],
  );

  function label(c: ChatChannelSummary): string {
    return c.kind === "CHANNEL"
      ? (c.name ?? c.id.slice(0, 6))
      : c.otherParticipants.map((p) => p.displayName).join(", ") || "DM";
  }

  // ── Detail: the selected channel's live conversation ──
  if (selected) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-10 shrink-0 items-center border-b border-[var(--border)] px-3">
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            aria-label="Back to channels"
            className="flex items-center gap-1.5 rounded p-1 text-sm font-semibold text-[var(--text)] hover:bg-[var(--primary-tint)]"
          >
            <ArrowLeft className="h-4 w-4 text-[var(--text-muted)]" />
            {label(selected)}
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <ChannelView orgId={orgId} channelId={selected.id} userId={userId} />
        </div>
      </div>
    );
  }

  // ── Master: the full chat sidebar, selecting in place ──
  // Force the sidebar to fill the drawer (it's w-64 on the page) and drop its
  // right border since there's no chat pane beside it here.
  return (
    <div className="h-full overflow-y-auto [&>aside]:!w-full [&>aside]:border-r-0">
      <ChatSidebar
        orgId={orgId}
        activeChannelId={selectedId ?? undefined}
        onSelectChannel={setSelectedId}
      />
    </div>
  );
}
