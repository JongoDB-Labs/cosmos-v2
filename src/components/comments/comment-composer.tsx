"use client";

import { useState } from "react";
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

/**
 * A CommentComposer that keeps its own draft, so a keystroke re-renders the
 * composer and nothing else. Hosting the draft in a big parent's state (the
 * work-item sheet did) re-renders that parent, and every comment's markdown
 * above the composer, on every key.
 *
 * The draft is still the host's to keep across an unmount — the sheet's
 * portal drops its content when it closes, and its tabs drop the composer —
 * so `initialDraft` restores it and `onDraftChange` reports each edit. Report
 * it into a ref, not state, or the host re-renders per keystroke again.
 *
 * `onSubmit` gets the trimmed draft and resolves true once it was saved; the
 * composer then clears itself. On false the draft stays for another try.
 */
export function DraftCommentComposer({
  initialDraft = "",
  onDraftChange,
  onSubmit,
  disabled = false,
  ...rest
}: Omit<
  Parameters<typeof CommentComposer>[0],
  "value" | "resetKey" | "onChange" | "onSubmit"
> & {
  initialDraft?: string | (() => string);
  onDraftChange?: (markdown: string) => void;
  onSubmit: (markdown: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(initialDraft);
  // Remounts the editor to clear it after a post (it reads its value once).
  const [resetKey, setResetKey] = useState(0);
  const [posting, setPosting] = useState(false);

  function change(markdown: string) {
    setDraft(markdown);
    onDraftChange?.(markdown);
  }

  async function submit() {
    const text = draft.trim();
    if (!text || posting) return;
    setPosting(true);
    try {
      if (await onSubmit(text)) {
        change("");
        setResetKey((k) => k + 1);
      }
    } finally {
      setPosting(false);
    }
  }

  return (
    <CommentComposer
      {...rest}
      value={draft}
      resetKey={resetKey}
      onChange={change}
      onSubmit={() => void submit()}
      disabled={disabled || posting}
    />
  );
}
