"use client";
import Link from "next/link";
import { Hash, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatChannelSummary } from "@/hooks/use-chat-channels";

export function ChannelList({
  channels,
  orgSlug,
  activeChannelId,
  onSelectChannel,
}: {
  channels: ChatChannelSummary[];
  orgSlug: string;
  activeChannelId?: string;
  /**
   * When provided, channels render as buttons that call this instead of
   * navigating — lets the docked Chat drawer select a channel IN PLACE without
   * routing the page behind it. Absent (the /chat page) → normal <Link>.
   */
  onSelectChannel?: (channelId: string) => void;
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
        return onSelectChannel ? (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelectChannel(c.id)}
            className={className}
          >
            {inner}
          </button>
        ) : (
          <Link key={c.id} href={`/${orgSlug}/chat/${c.id}`} className={className}>
            {inner}
          </Link>
        );
      })}
    </div>
  );
}
