"use client";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { ChatChannelSummary } from "@/hooks/use-chat-channels";
import { PresenceDot } from "./presence-dot";

export function DmList({
  channels,
  orgSlug,
  activeChannelId,
  online,
  onSelectChannel,
}: {
  channels: ChatChannelSummary[];
  orgSlug: string;
  activeChannelId?: string;
  online: Set<string>;
  /** See ChannelList — select-in-place for the docked Chat drawer. */
  onSelectChannel?: (channelId: string) => void;
}) {
  if (channels.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {channels.map((c) => {
        const active = c.id === activeChannelId;
        const label =
          c.otherParticipants.length === 0
            ? "You"
            : c.otherParticipants.map((p) => p.displayName).join(", ");
        const className = cn(
          "flex w-full items-center gap-2 px-2 py-1 rounded text-sm text-left hover:bg-accent",
          active && "bg-accent font-medium",
        );
        const inner = (
          <>
            <PresenceDot
              online={c.otherParticipants.some((p) => online.has(p.id))}
            />
            <span className="truncate">{label}</span>
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
