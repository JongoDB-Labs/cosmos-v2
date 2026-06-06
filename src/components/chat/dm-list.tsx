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
}: {
  channels: ChatChannelSummary[];
  orgSlug: string;
  activeChannelId?: string;
  online: Set<string>;
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
        return (
          <Link
            key={c.id}
            href={`/${orgSlug}/chat/${c.id}`}
            className={cn(
              "flex items-center gap-2 px-2 py-1 rounded text-sm hover:bg-accent",
              active && "bg-accent font-medium",
            )}
          >
            <PresenceDot online={c.otherParticipants.some((p) => online.has(p.id))} />
            <span className="truncate">{label}</span>
          </Link>
        );
      })}
    </div>
  );
}
