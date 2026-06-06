"use client";
import { Pin, X } from "lucide-react";
import type { PinnedDto } from "@/hooks/use-pinned-messages";

export function PinnedPanel({
  pins,
  usersById,
  onJump,
  onClose,
}: {
  pins: PinnedDto[];
  usersById: Map<string, { displayName: string; avatarUrl: string | null }>;
  onJump: (messageId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute right-2 top-12 z-50 w-80 max-h-96 overflow-y-auto bg-popover border rounded shadow-md">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <span className="text-sm font-semibold flex items-center gap-1">
          <Pin className="h-3.5 w-3.5" /> Pinned ({pins.length})
        </span>
        <button type="button" onClick={onClose} aria-label="Close pinned">
          <X className="h-4 w-4" />
        </button>
      </div>
      {pins.length === 0 ? (
        <div className="p-3 text-xs text-muted-foreground">No pinned messages yet.</div>
      ) : (
        pins.map((p) => (
          <button
            type="button"
            key={p.message.id}
            onClick={() => onJump(p.message.id)}
            className="w-full text-left px-3 py-2 hover:bg-accent border-t first:border-t-0"
          >
            <div className="text-xs font-medium">
              {usersById.get(p.message.authorId)?.displayName ?? "User"}
            </div>
            <div className="text-xs text-muted-foreground line-clamp-2">
              {p.message.content || "[no text]"}
            </div>
          </button>
        ))
      )}
    </div>
  );
}
