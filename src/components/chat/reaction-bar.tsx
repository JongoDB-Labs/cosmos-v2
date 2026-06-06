"use client";
import { cn } from "@/lib/utils";
import type { ChatMessageReactionDto } from "@/hooks/use-chat-messages";

export function ReactionBar({
  reactions,
  currentUserId,
  onToggle,
}: {
  reactions: ChatMessageReactionDto[];
  currentUserId: string;
  onToggle: (emoji: string, isOwn: boolean) => void;
}) {
  const grouped = new Map<string, { count: number; userIds: string[] }>();
  for (const r of reactions) {
    const g = grouped.get(r.emoji) ?? { count: 0, userIds: [] };
    g.count++;
    g.userIds.push(r.userId);
    grouped.set(r.emoji, g);
  }
  if (grouped.size === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {[...grouped.entries()].map(([emoji, g]) => {
        const isOwn = g.userIds.includes(currentUserId);
        return (
          <button
            type="button"
            key={emoji}
            onClick={() => onToggle(emoji, isOwn)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
              isOwn ? "bg-accent border-primary" : "hover:bg-accent",
            )}
            aria-label={`${emoji} ${g.count}, ${isOwn ? "click to remove" : "click to add"}`}
          >
            <span>{emoji}</span>
            <span>{g.count}</span>
          </button>
        );
      })}
    </div>
  );
}
