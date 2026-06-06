"use client";
import { Fragment, useEffect, useRef } from "react";
import { MessageItem } from "./message-item";
import { ReadReceiptAvatars } from "./read-receipt-avatars";
import type { ChatMessageDto } from "@/hooks/use-chat-messages";

export function MessageList({
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

  const mentionMap = new Map<string, string>();
  for (const [id, u] of usersById) mentionMap.set(id, u.displayName);

  return (
    <div role="log" className="flex-1 overflow-y-auto">
      {messages.map((m) => {
        const readers = [...readState.entries()]
          .filter(([, lastReadId]) => lastReadId === m.id)
          .map(([uid]) => usersById.get(uid))
          .filter((u): u is { displayName: string; avatarUrl: string | null } => !!u);
        return (
          <Fragment key={m.id}>
            <MessageItem
              message={m}
              author={
                usersById.get(m.authorId) ?? {
                  displayName: "User",
                  avatarUrl: null,
                }
              }
              isOwn={m.authorId === currentUserId}
              currentUserId={currentUserId}
              mentionMap={mentionMap}
              isPinned={pinnedIds.has(m.id)}
              onEdit={() => onEdit(m.id, m.content)}
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
