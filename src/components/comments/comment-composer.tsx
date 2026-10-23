"use client";

import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NoteRichTextEditor } from "@/components/notes/editor/rich-text-editor";
import { COMMENT_EDITOR_SIZING } from "@/components/notes/editor/sizing";

/**
 * The comment composer: the compact rich-text editor (@ mentions included) and
 * its send button. Shared by work-item and feedback discussions so they post
 * the same way. `resetKey` remounts the editor, which is how it clears after a
 * successful post.
 */
export function CommentComposer({
  orgId,
  value,
  resetKey,
  onChange,
  onSubmit,
  mentionLabels,
  disabled = false,
  placeholder = "Write a comment… (@ to mention)",
  ariaLabel = "Comment",
  submitLabel = "Add comment",
}: {
  orgId: string;
  value: string;
  resetKey: string | number;
  onChange: (markdown: string) => void;
  onSubmit: () => void;
  mentionLabels: Map<string, string>;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  submitLabel?: string;
}) {
  return (
    <div className="relative flex gap-2">
      <div className="min-w-0 flex-1 rounded-lg border border-input px-2.5 py-1.5 text-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50">
        <NoteRichTextEditor
          key={`comment-${resetKey}`}
          initialMarkdown={value}
          orgId={orgId}
          mentionLabels={mentionLabels}
          onChange={onChange}
          placeholder={placeholder}
          ariaLabel={ariaLabel}
          sizing={COMMENT_EDITOR_SIZING}
        />
      </div>
      <Button
        size="icon"
        variant="ghost"
        aria-label={submitLabel}
        onClick={onSubmit}
        disabled={!value.trim() || disabled}
      >
        <Send className="h-4 w-4" />
      </Button>
    </div>
  );
}
