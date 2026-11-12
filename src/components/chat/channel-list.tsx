"use client";
import { Hash, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatChannelSummary } from "@/hooks/use-chat-channels";

export function ChannelList({
  channels,
  activeChannelId,
  onSelectChannel,
}: {
  channels: ChatChannelSummary[];
  activeChannelId?: string;
  /**
   * Opens the channel in the docked Chat drawer, in place: rows are buttons,
   * never links, so the page behind the drawer stays put.
   */
  onSelectChannel: (channelId: string) => void;
}) {
  if (channels.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {channels.map((c) => {
        const active = c.id === activeChannelId;
        const Icon = c.isPrivate ? Lock : Hash;
        const className = cn(
          "flex w-full items-center gap-2 px-2 py-1 rounded text-sm text-left hover:bg-accent",
          active && "bg-accent font-medium",
        );
        const inner = (
          <>
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{c.name ?? c.id.slice(0, 6)}</span>
          </>
        );
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelectChannel(c.id)}
            className={className}
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}
