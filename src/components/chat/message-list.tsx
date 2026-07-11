"use client";
import { Fragment, useEffect, useMemo, useRef } from "react";
import { MessageItem } from "./message-item";
import { ReadReceiptAvatars } from "./read-receipt-avatars";
import type { ChatMessageDto } from "@/hooks/use-chat-messages";
import { useRefResolver } from "@/components/mentions/hooks";
import { refKey, type ResolvedEntity } from "@/lib/mentions/refs";
import { startsNewTimeGroup } from "@/lib/chat/message-time";

export function MessageList({
  orgId,
  messages,
  usersById,
  currentUserId,
  readState,
  pinnedIds,
  onEdit,
  onDelete,
  onReact,
  onOpenThread,
  onTogglePin,
}: {
  orgId: string;
  messages: ChatMessageDto[];
  usersById: Map<string, { displayName: string; avatarUrl: string | null }>;
  currentUserId: string;
  readState: Map<string, string>;
  pinnedIds: Set<string>;
  onEdit: (id: string, content: string) => void;
  onDelete: (id: string) => void;
  onReact: (id: string, emoji: string, isOwn: boolean) => void;
  onOpenThread: (m: ChatMessageDto) => void;
  onTogglePin: (messageId: string, isPinned: boolean) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  // Seed person chips instantly from the loaded member map; resolve every other
  // referenced entity via the batch endpoint. `refMap` is keyed by refKey().
  const userSeed = useMemo(() => {
    const m = new Map<string, ResolvedEntity>();
    for (const [id, u] of usersById)
      m.set(refKey("user", id), { type: "user", id, label: u.displayName, url: null });
    return m;
  }, [usersById]);
  const contents = useMemo(() => messages.map((mm) => mm.content), [messages]);
  const refMap = useRefResolver(orgId, contents, userSeed);

  return (
    <div role="log" className="flex-1 overflow-y-auto">
      {messages.map((m, i) => {
        const readers = [...readState.entries()]
          .filter(([, lastReadId]) => lastReadId === m.id)
          .map(([uid]) => usersById.get(uid))
          .filter((u): u is { displayName: string; avatarUrl: string | null } => !!u);
        // FR 78b5b1bd: run-on messages from the same author within 5 minutes
        // render compact (no avatar/name repeat) — plain messages only, so
        // SYSTEM/ASSISTANT/ACTION rows always keep their full header.
        const prev = i > 0 ? messages[i - 1] : null;
        const grouped =
          !!prev &&
          prev.authorId === m.authorId &&
          m.kind === "USER" &&
          prev.kind === "USER" &&
          new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() <
            5 * 60_000;
        // FR 78b5b1bd: only surface a timestamp for the first message of the
        // day and the first message after a stretch of silence (channel-wide,
        // regardless of author) — otherwise it's suppressed for the burst.
        const showTimestamp = startsNewTimeGroup(prev?.createdAt, m.createdAt);
        return (
          <Fragment key={m.id}>
            <MessageItem
              message={m}
              grouped={grouped}
              showTimestamp={showTimestamp}
              author={
                usersById.get(m.authorId) ?? {
                  displayName: "User",
                  avatarUrl: null,
                }
              }
              isOwn={m.authorId === currentUserId}
              currentUserId={currentUserId}
              refMap={refMap}
              isPinned={pinnedIds.has(m.id)}
              onEdit={(next) => onEdit(m.id, next)}
              onDelete={() => onDelete(m.id)}
              onReact={(emoji, isOwn) => onReact(m.id, emoji, isOwn)}
              onOpenThread={() => onOpenThread(m)}
              onTogglePin={() => onTogglePin(m.id, pinnedIds.has(m.id))}
            />
            <ReadReceiptAvatars readers={readers} />
          </Fragment>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
