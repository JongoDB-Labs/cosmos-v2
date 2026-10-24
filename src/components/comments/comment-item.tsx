"use client";

import { useState, type ReactNode } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { LocalTimestamp } from "@/components/ui/local-timestamp";
import { MarkdownContent, type RefMap } from "@/components/chat/markdown-content";
import { NoteRichTextEditor } from "@/components/notes/editor/rich-text-editor";
import { COMMENT_EDITOR_SIZING } from "@/components/notes/editor/sizing";
import { cn } from "@/lib/utils";

/**
 * One comment: author, time, an "edited" marker, the author's edit and the
 * author's (or a manager's) delete, and its markdown with entity chips.
 * Shared by work-item and feedback discussions. Edit mode is the comment's
 * own: `onSave` resolves true once the server took the change.
 */
export function CommentItem({
  id,
  authorName,
  createdAt,
  edited,
  editedLabel,
  content,
  refMap,
  orgId,
  mentionLabels,
  canEdit,
  canDelete,
  onSave,
  onDelete,
  badge,
  actions,
  highlighted = false,
  children,
}: {
  /** Anchors the comment for `#c-<id>` deep links. */
  id?: string;
  authorName: string;
  createdAt: string | Date;
  edited: boolean;
  /** Replaces the plain " · edited" text, e.g. with a history button. */
  editedLabel?: ReactNode;
  content: string;
  refMap: RefMap;
  orgId: string;
  mentionLabels: Map<string, string>;
  canEdit: boolean;
  canDelete: boolean;
  onSave: (content: string) => Promise<boolean>;
  onDelete: () => void;
  /** Shown after the author's name (e.g. "Team"). */
  badge?: ReactNode;
  /** Shown under the content (e.g. Reply). */
  actions?: ReactNode;
  highlighted?: boolean;
  /** Replies. */
  children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  async function save() {
    const next = draft.trim();
    if (!next) return;
    if (await onSave(next)) {
      setEditing(false);
      setDraft("");
    }
  }

  return (
    <div
      id={id ? `c-${id}` : undefined}
      className={cn("group/comment flex gap-2", highlighted && "rounded-md bg-amber-500/10 ring-1 ring-amber-500/40")}
    >
      <Avatar size="sm">
        <AvatarFallback>{authorName.charAt(0).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">{authorName}</span>
          {badge}
          {/* <LocalTimestamp> and not formatDateTimeStable: the stable
              formatters are pinned to UTC, which tells a reader west of UTC the
              wrong hour for an instant. It renders the pinned string for the
              first paint (so hydration matches), then the viewer's own zone. */}
          <span className="text-[10px] text-muted-foreground">
            <LocalTimestamp value={createdAt} />
            {edited ? (editedLabel ?? " · edited") : ""}
          </span>
          {!editing && (canEdit || canDelete) && (
            <span className="ml-auto flex items-center gap-1.5 opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100">
              {canEdit && (
                <button
                  type="button"
                  aria-label="Edit comment"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setEditing(true);
                    setDraft(content);
                  }}
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  aria-label="Delete comment"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={onDelete}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </span>
          )}
        </div>
        {editing ? (
          <div className="mt-1 space-y-1.5">
            <div className="rounded-lg border border-input px-2.5 py-1.5 text-sm">
              <NoteRichTextEditor
                key={`edit-${id ?? "comment"}`}
                initialMarkdown={draft}
                orgId={orgId}
                mentionLabels={mentionLabels}
                onChange={setDraft}
                ariaLabel="Edit comment"
                sizing={COMMENT_EDITOR_SIZING}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button size="xs" onClick={() => void save()} disabled={!draft.trim()}>
                Save
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setDraft("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground mt-0.5">
            <MarkdownContent content={content} refMap={refMap} />
          </div>
        )}
        {actions}
        {children}
      </div>
    </div>
  );
}
