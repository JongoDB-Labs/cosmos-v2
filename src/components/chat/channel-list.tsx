"use client";
import Link from "next/link";
import { Hash, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatChannelSummary } from "@/hooks/use-chat-channels";

export function ChannelList({
  channels,
  orgSlug,
  activeChannelId,
}: {
  channels: ChatChannelSummary[];
  orgSlug: string;
  activeChannelId?: string;
}) {
  if (channels.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {channels.map((c) => {
        const active = c.id === activeChannelId;
        const Icon = c.isPrivate ? Lock : Hash;
        return (
          <Link
            key={c.id}
            href={`/${orgSlug}/chat/${c.id}`}
            className={cn(
              "flex items-center gap-2 px-2 py-1 rounded text-sm hover:bg-accent",
              active && "bg-accent font-medium",
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{c.name ?? c.id.slice(0, 6)}</span>
          </Link>
        );
      })}
    </div>
  );
}
