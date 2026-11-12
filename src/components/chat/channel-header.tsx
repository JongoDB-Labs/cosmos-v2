"use client";
import { useState } from "react";
import { Hash, Lock, Pin, Settings2 } from "lucide-react";
import type { ChatChannelSummary } from "@/hooks/use-chat-channels";
import { ChannelSettingsDialog } from "./channel-settings-dialog";
import { NotificationPrefMenu } from "./notification-pref-menu";

/**
 * The open conversation's title bar. No back control of its own: the Chat
 * drawer frames every conversation with its "Back to channels" bar, and the
 * mobile-only link that used to sit here pointed at the full-page chat.
 */
export function ChannelHeader({
  channel,
  orgId,
  pinCount,
  onTogglePins,
  onArchived,
}: {
  channel: ChatChannelSummary;
  orgId: string;
  pinCount: number;
  onTogglePins: () => void;
  /** The channel was archived from its settings, so it can't be viewed any more. */
  onArchived: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const Icon = channel.isPrivate ? Lock : Hash;
  const title =
    channel.kind === "CHANNEL"
      ? channel.name ?? channel.id.slice(0, 6)
      : channel.otherParticipants.map((p) => p.displayName).join(", ") ||
        "Direct message";

  return (
    <header className="flex items-center justify-between px-4 py-3 border-b shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        {channel.kind === "CHANNEL" && (
          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
        {/* Channel name is a section heading within the chat drawer; the
            page beside it owns the H1. */}
        <h2 className="font-semibold truncate text-base">{title}</h2>
        {channel.topic && (
          <span className="text-xs text-muted-foreground truncate border-l pl-2">
            {channel.topic}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onTogglePins}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1"
          aria-label="Pinned messages"
        >
          <Pin className="h-4 w-4" />
          {pinCount > 0 && <span className="text-xs">{pinCount}</span>}
        </button>
        <NotificationPrefMenu
          orgId={orgId}
          channelId={channel.id}
          current={channel.notificationPref}
        />
        {channel.kind === "CHANNEL" && channel.canManage && (
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Channel settings"
            title="Channel settings"
          >
            <Settings2 className="h-4 w-4" />
          </button>
        )}
      </div>
      {channel.kind === "CHANNEL" && channel.canManage && (
        <ChannelSettingsDialog
          orgId={orgId}
          channel={channel}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          onArchived={onArchived}
        />
      )}
    </header>
  );
}
