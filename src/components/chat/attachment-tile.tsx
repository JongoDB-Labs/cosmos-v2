"use client";
import { Paperclip } from "lucide-react";
import type { ChatMessageAttachmentDto } from "@/hooks/use-chat-messages";

export function AttachmentTile({ attachment }: { attachment: ChatMessageAttachmentDto }) {
  if (attachment.kind === "image") {
    return (
      <a href={attachment.url} target="_blank" rel="noopener noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={attachment.url}
          alt={attachment.filename}
          className="max-h-64 max-w-md rounded border block"
          style={
            attachment.width && attachment.height
              ? { aspectRatio: `${attachment.width}/${attachment.height}` }
              : undefined
          }
        />
      </a>
    );
  }
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded border px-2 py-1 text-xs hover:bg-accent"
    >
      <Paperclip className="h-3 w-3" />
      <span className="truncate max-w-[200px]">{attachment.filename}</span>
      <span className="text-muted-foreground">{Math.round(attachment.size / 1024)} KB</span>
    </a>
  );
}
