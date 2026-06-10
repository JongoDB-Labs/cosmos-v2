"use client";
import Link from "next/link";
import { ChevronLeft, Hash, Lock, Pin } from "lucide-react";
import { usePathname } from "next/navigation";
import type { ChatChannelSummary } from "@/hooks/use-chat-channels";

export function ChannelHeader({
  channel,
  pinCount,
  onTogglePins,
}: {
  channel: ChatChannelSummary;
  pinCount: number;
  onTogglePins: () => void;
}) {
  const pathname = usePathname();
  const orgSlug = pathname.split("/")[1] ?? "";
  const Icon = channel.isPrivate ? Lock : Hash;
  const title =
    channel.kind === "CHANNEL"
      ? channel.name ?? channel.id.slice(0, 6)
      : channel.otherParticipants.map((p) => p.displayName).join(", ") ||
        "Direct message";

  return (
    <header className="flex items-center justify-between px-4 py-3 border-b shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <Link
          href={`/${orgSlug}/chat`}
          className="md:hidden text-muted-foreground hover:text-foreground"
          aria-label="Back to channels"
        >
          <ChevronLeft className="h-4 w-4" />
        </Link>
        {channel.kind === "CHANNEL" && (
          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
        {/* Channel name is a section heading within the chat surface; the
            page-level H1 ("Chat") is owned by the page shell. */}
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
      </div>
    </header>
  );
}
