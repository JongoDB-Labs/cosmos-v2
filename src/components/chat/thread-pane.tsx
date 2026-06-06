"use client";
import { useQueryClient } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useChatThread } from "@/hooks/use-chat-thread";
import { useRealtimeEvents } from "@/hooks/use-realtime-events";
import { X } from "lucide-react";
import { MessageItem } from "./message-item";
import { Composer } from "./composer";
import type { ChatMessageDto } from "@/hooks/use-chat-messages";

export function ThreadPane({
  orgId,
  channelId,
  parentMessage,
  currentUserId,
  usersById,
  onClose,
  onSendReply,
}: {
  orgId: string;
  channelId: string;
  parentMessage: ChatMessageDto;
  currentUserId: string;
  usersById: Map<string, { displayName: string; avatarUrl: string | null }>;
  onClose: () => void;
  onSendReply: (parentId: string, content: string) => Promise<void>;
}) {
  const qc = useQueryClient();
  const threadKey = useOrgQueryKey("chat-thread", channelId, parentMessage.id);
  const { data } = useChatThread(orgId, channelId, parentMessage.id);

  useRealtimeEvents(orgId, {
    "chat.message.created": (raw: unknown) => {
      const d = raw as Partial<ChatMessageDto>;
      if (d.parentMessageId !== parentMessage.id) return;
      qc.setQueryData<ChatMessageDto[]>(threadKey, (prev) => {
        if (!prev) return [d as ChatMessageDto];
        if (prev.some((m) => m.id === d.id)) return prev;
        return [
          ...prev,
          {
            id: d.id!,
            channelId: d.channelId!,
            authorId: d.authorId!,
            content: d.content ?? "",
            kind: d.kind ?? "USER",
            parentMessageId: d.parentMessageId ?? null,
            editedAt: d.editedAt ?? null,
            deletedAt: d.deletedAt ?? null,
            createdAt: d.createdAt!,
            reactions: d.reactions ?? [],
            attachments: d.attachments ?? [],
            replyCount: d.replyCount ?? 0,
          },
        ];
      });
    },
  });

  const mentionMap = new Map<string, string>();
  for (const [id, u] of usersById) mentionMap.set(id, u.displayName);

  const noop = () => {};
  const noopReact = () => {};
  const noopOpenThread = () => {};
  const noopTogglePin = () => {};

  return (
    <aside className="w-96 border-l flex flex-col">
      <header className="px-3 py-2 flex items-center justify-between border-b shrink-0">
        <span className="text-sm font-semibold">Thread</span>
        <button type="button" onClick={onClose} aria-label="Close thread">
          <X className="h-4 w-4" />
        </button>
      </header>
      <ul className="flex-1 overflow-y-auto">
        <MessageItem
          message={parentMessage}
          author={usersById.get(parentMessage.authorId) ?? { displayName: "User", avatarUrl: null }}
          isOwn={parentMessage.authorId === currentUserId}
          mentionMap={mentionMap}
          currentUserId={currentUserId}
          isPinned={false}
          onEdit={noop}
          onDelete={noop}
          onReact={noopReact}
          onOpenThread={noopOpenThread}
          onTogglePin={noopTogglePin}
        />
        <li className="border-t" />
        {(data ?? []).map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            author={usersById.get(m.authorId) ?? { displayName: "User", avatarUrl: null }}
            isOwn={m.authorId === currentUserId}
            mentionMap={mentionMap}
            currentUserId={currentUserId}
            isPinned={false}
            onEdit={noop}
            onDelete={noop}
            onReact={noopReact}
            onOpenThread={noopOpenThread}
            onTogglePin={noopTogglePin}
          />
        ))}
      </ul>
      <Composer
        orgId={orgId}
        channelLabel={`thread on ${parentMessage.content.slice(0, 20)}…`}
        onSend={(content) => onSendReply(parentMessage.id, content)}
        canManage={false}
        onCommand={noop}
        onHelp={noop}
        onDm={noop}
      />
    </aside>
  );
}
