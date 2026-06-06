"use client";
import { useState } from "react";
import { Smile, MessageSquare, Pin } from "lucide-react";
import { MarkdownContent } from "./markdown-content";
import { ReactionBar } from "./reaction-bar";
import { EmojiPicker } from "./emoji-picker";
import { AttachmentTile } from "./attachment-tile";
import type { ChatMessageDto } from "@/hooks/use-chat-messages";

export function MessageItem({
  message,
  author,
  isOwn,
  currentUserId,
  mentionMap,
  isPinned,
  onEdit,
  onDelete,
  onReact,
  onOpenThread,
  onTogglePin,
}: {
  message: ChatMessageDto;
  author: { displayName: string; avatarUrl: string | null };
  isOwn: boolean;
  currentUserId: string;
  mentionMap: Map<string, string>;
  isPinned: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onReact: (emoji: string, isOwn: boolean) => void;
  onOpenThread: () => void;
  onTogglePin: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const tombstone = message.deletedAt != null;

  // SYSTEM: centered muted breadcrumb — no avatar, no hover actions, no reactions
  if (message.kind === "SYSTEM") {
    return (
      <li className="px-4 py-1 text-center text-xs text-muted-foreground" id={`msg-${message.id}`}>
        {message.content}
      </li>
    );
  }

  return (
    <li
      className="group flex gap-3 px-4 py-2 hover:bg-accent/30"
      id={`msg-${message.id}`}
    >
      <div className="h-8 w-8 rounded-full bg-muted overflow-hidden shrink-0">
        {author.avatarUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={author.avatarUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          {message.kind === "ASSISTANT" ? (
            <>
              <span className="font-medium text-sm">🤖 Assistant</span>
              <span className="text-[10px] text-muted-foreground">· asked by {author.displayName}</span>
              <span className="text-[10px] text-muted-foreground">
                {new Date(message.createdAt).toLocaleTimeString()}
              </span>
              {message.editedAt && (
                <span className="text-[10px] text-muted-foreground">(edited)</span>
              )}
            </>
          ) : (
            <>
              <span className="font-medium text-sm">{author.displayName}</span>
              <span className="text-[10px] text-muted-foreground">
                {new Date(message.createdAt).toLocaleTimeString()}
              </span>
              {message.editedAt && (
                <span className="text-[10px] text-muted-foreground">(edited)</span>
              )}
            </>
          )}
        </div>
        <div className="text-sm">
          {message.kind === "ACTION" ? (
            <div className="italic text-muted-foreground">* {author.displayName} {message.content}</div>
          ) : tombstone ? (
            <span className="text-muted-foreground italic">
              [message deleted]
            </span>
          ) : (
            <MarkdownContent content={message.content} mentionMap={mentionMap} />
          )}
        </div>
        {!tombstone && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-1">
            {message.attachments.map((a) => (
              <AttachmentTile key={a.id} attachment={a} />
            ))}
          </div>
        )}
        <ReactionBar
          reactions={message.reactions}
          currentUserId={currentUserId}
          onToggle={onReact}
        />
        {!tombstone && message.replyCount > 0 && (
          <button
            type="button"
            onClick={onOpenThread}
            className="mt-1 text-xs text-primary hover:underline"
          >
            ↳ {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
          </button>
        )}
      </div>
      {!tombstone && (
        <div className="relative opacity-0 group-hover:opacity-100 flex gap-1 text-xs items-center">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Add reaction"
          >
            <Smile className="h-3 w-3" />
          </button>
          {pickerOpen && (
            <div className="absolute z-10 mt-6 right-0 top-0">
              <EmojiPicker
                onPick={(emoji) => {
                  onReact(emoji, false);
                  setPickerOpen(false);
                }}
              />
            </div>
          )}
          <button
            type="button"
            onClick={onOpenThread}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Reply in thread"
          >
            <MessageSquare className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onTogglePin}
            className="text-muted-foreground hover:text-foreground"
            aria-label={isPinned ? "Unpin message" : "Pin message"}
          >
            <Pin className={isPinned ? "h-3 w-3 fill-current" : "h-3 w-3"} />
          </button>
          {isOwn && (
            <>
              <button
                type="button"
                onClick={onEdit}
                className="text-muted-foreground hover:text-foreground"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="text-muted-foreground hover:text-destructive"
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
