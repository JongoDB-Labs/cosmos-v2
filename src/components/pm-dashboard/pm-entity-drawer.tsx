"use client";

import { useState, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DatePicker } from "@/components/ui/date-picker";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { notifyError } from "@/lib/errors/notify";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey, useOrgSlug, orgQueryKey } from "@/lib/query/keys";
import {
  MentionPicker,
  useOrgMembers,
  type OrgUser,
} from "@/components/chat/mention-typeahead";
import type { PmSubjectType } from "@/lib/pm/subjects";
import {
  MessageSquare,
  History,
  Send,
  Pencil,
  Trash2,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Public field model. A consumer (each register) describes the entity's
// editable surface declaratively; the drawer renders the right control per
// `type` and persists a single-key PATCH on blur/change. `value` is the
// current server value; `editable:false` renders as static text.
// ---------------------------------------------------------------------------
export type PmFieldType = "text" | "textarea" | "number" | "date" | "select";

export interface PmField {
  /** The PATCH body key, e.g. "title", "likelihood", "branchId". */
  key: string;
  label: string;
  type: PmFieldType;
  /** Current value (string | number | null). Dates are ISO or yyyy-mm-dd. */
  value: string | number | null;
  editable: boolean;
  /** For type:"select" — the option set. */
  options?: { value: string; label: string }[];
  /** Optional min/max for type:"number". */
  min?: number;
  max?: number;
  /** Optional helper/placeholder text. */
  placeholder?: string;
  /**
   * Optional coercion applied to the chosen value just before it's PATCHed —
   * for fields whose API type isn't the string the control emits. e.g. a
   * boolean "escalate" select uses `coerce: (v) => v === "true"`.
   */
  coerce?: (value: string) => unknown;
}

export interface PmEntityDrawerProps {
  orgId: string;
  projectId: string;
  subjectType: PmSubjectType;
  /** Null while closed / no row selected — the drawer renders nothing. */
  subjectId: string | null;
  title: string;
  code?: string | null;
  fields: PmField[];
  /** Full path to PATCH for inline field edits, e.g. `${apiBase}/${id}`. */
  patchPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a field PATCH succeeds (so the parent can refetch its list). */
  onSaved?: () => void;
}

// Comment shape from the pm-comments GET contract.
interface PmComment {
  id: string;
  content: string;
  authorId: string;
  authorName: string | null;
  authorAvatarUrl: string | null;
  createdAt: string;
  updatedAt: string | null;
  canEdit: boolean;
  canDelete: boolean;
}

// Activity shape from the pm-activity GET contract.
interface PmActivity {
  id: string;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  userId: string;
  userName: string | null;
  createdAt: string;
}

/** Relative-time formatter (no date-fns in this repo). Falls back to a date. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Render a comment body, turning `<@uuid>` mention tokens into "@Name" using
 * the org member list. Mirrors the work-item comment mention rendering. Unknown
 * ids render as "@user".
 */
function renderCommentBody(content: string, members: OrgUser[]): React.ReactNode {
  const parts = content.split(/(<@[0-9a-f-]{36}>)/gi);
  return parts.map((part, i) => {
    const m = part.match(/^<@([0-9a-f-]{36})>$/i);
    if (!m) return <span key={i}>{part}</span>;
    const user = members.find((u) => u.id === m[1]);
    return (
      <span
        key={i}
        className="rounded bg-[var(--primary)]/12 px-1 font-medium text-[var(--primary)]"
      >
        @{user?.displayName ?? "user"}
      </span>
    );
  });
}

export function PmEntityDrawer({
  orgId,
  projectId,
  subjectType,
  subjectId,
  title,
  code,
  fields,
  patchPath,
  open,
  onOpenChange,
  onSaved,
}: PmEntityDrawerProps) {
  const orgSlug = useOrgSlug();
  const qc = useQueryClient();

  // Local, optimistic copy of each field's value, keyed by field.key. Seeded
  // from props whenever the open subject changes; an inline edit sets the local
  // value immediately, then reverts just that key if the PATCH fails.
  // Seed the optimistic field map from props at mount. The parent keys this
  // drawer by subjectId, so switching rows remounts the component and every
  // piece of per-row state (values, tab, draft comment, open edit) reinitializes
  // from props — no setState-in-effect needed.
  const [values, setValues] = useState<Record<string, string | number | null>>(() => {
    const seed: Record<string, string | number | null> = {};
    for (const f of fields) seed[f.key] = f.value;
    return seed;
  });

  const [tab, setTab] = useState<"comments" | "activity">("comments");

  // Query keys are org-scoped + subject-scoped so two open drawers (or the same
  // subject reopened) share one cache entry and invalidate cleanly.
  const commentsKey = useOrgQueryKey("pm-comments", subjectType, subjectId);
  const activityKey = useOrgQueryKey("pm-activity", subjectType, subjectId);

  const commentsBase = `/api/v1/orgs/${orgId}/projects/${projectId}/pm-comments`;
  const activityBase = `/api/v1/orgs/${orgId}/projects/${projectId}/pm-activity`;

  const { data: comments = [] } = useQuery({
    queryKey: commentsKey,
    enabled: open && !!subjectId,
    queryFn: () =>
      jsonFetch<PmComment[]>(
        `${commentsBase}?subjectType=${subjectType}&subjectId=${subjectId}`,
      ),
  });
  const { data: activities = [] } = useQuery({
    queryKey: activityKey,
    enabled: open && !!subjectId,
    queryFn: () =>
      jsonFetch<PmActivity[]>(
        `${activityBase}?subjectType=${subjectType}&subjectId=${subjectId}`,
      ),
  });

  const { data: mentionMembers } = useOrgMembers(orgId);
  const members = mentionMembers ?? [];

  function invalidateComments() {
    void qc.invalidateQueries({
      queryKey: orgQueryKey(orgSlug, "pm-comments", subjectType, subjectId),
    });
  }
  function invalidateActivity() {
    void qc.invalidateQueries({
      queryKey: orgQueryKey(orgSlug, "pm-activity", subjectType, subjectId),
    });
  }

  // --- Inline field editing --------------------------------------------------
  // `local` is what we store in the optimistic display map (always the control's
  // string/number/null); `wire` is what we PATCH (post-coercion — e.g. boolean).
  const patchField = useCallback(
    async (key: string, local: string | number | null, wire: unknown) => {
      const prev = fields.find((f) => f.key === key)?.value ?? null;
      // Optimistic local set.
      setValues((v) => ({ ...v, [key]: local }));
      try {
        await jsonFetch(patchPath, {
          method: "PATCH",
          body: JSON.stringify({ [key]: wire }),
        });
        onSaved?.();
        // A field change may have produced derived/audited changes server-side
        // (score/level) and an Activity row — refresh the activity log.
        invalidateActivity();
      } catch (err) {
        // Revert just this field.
        setValues((v) => ({ ...v, [key]: prev }));
        notifyError(err, "Couldn't save the change.");
      }
    },
    // patchPath/fields are stable enough per-open; values setter is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patchPath, onSaved, fields],
  );

  // --- Comment composer (with @-mention typeahead) ---------------------------
  const [newComment, setNewComment] = useState("");
  const [posting, setPosting] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [mentionState, setMentionState] = useState<{
    q: string;
    anchor: { top: number; left: number };
  } | null>(null);

  function detectMention(text: string, caret: number): string | null {
    const before = text.slice(0, caret);
    const m = before.match(/(?:^|\s)@([\w-]*)$/);
    return m ? m[1] : null;
  }

  function onComposerChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setNewComment(e.target.value);
    const q = detectMention(e.target.value, e.target.selectionStart ?? 0);
    if (q !== null) {
      const rect = e.target.getBoundingClientRect();
      setMentionState({ q, anchor: { top: rect.top - 8 - 200, left: rect.left + 32 } });
    } else {
      setMentionState(null);
    }
  }

  function pickMention(user: OrgUser) {
    const ta = composerRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? newComment.length;
    const before = newComment
      .slice(0, caret)
      .replace(/(?:^|\s)@([\w-]*)$/, (m) => m.replace(/@[\w-]*$/, `<@${user.id}>`));
    const after = newComment.slice(caret);
    setNewComment(before + after);
    setMentionState(null);
    const caretAfter = before.length;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(caretAfter, caretAfter);
    });
  }

  function onComposerKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionState) return; // MentionPicker owns Arrow/Enter/Escape
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handlePostComment();
    }
  }

  async function handlePostComment() {
    const content = newComment.trim();
    if (!content || !subjectId || posting) return;
    setPosting(true);
    try {
      await jsonFetch(commentsBase, {
        method: "POST",
        body: JSON.stringify({ subjectType, subjectId, content }),
      });
      setNewComment("");
      // POST returns the bare row (no author enrichment) — refetch the enriched
      // list rather than guess. Activity gets a "commented" row server-side.
      invalidateComments();
      invalidateActivity();
    } catch (err) {
      notifyError(err, "Couldn't post your comment.");
    } finally {
      setPosting(false);
    }
  }

  // --- Comment edit / delete -------------------------------------------------
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  async function handleSaveCommentEdit(id: string) {
    const content = editDraft.trim();
    if (!content) return;
    try {
      await jsonFetch(`${commentsBase}/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ content }),
      });
      setEditingCommentId(null);
      setEditDraft("");
      invalidateComments();
    } catch (err) {
      notifyError(err, "Couldn't save the edit.");
    }
  }

  async function handleDeleteComment(id: string) {
    try {
      await jsonFetch(`${commentsBase}/${id}`, { method: "DELETE" });
      invalidateComments();
    } catch (err) {
      notifyError(err, "Couldn't delete the comment.");
    }
  }

  if (!subjectId) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="data-[side=right]:w-full data-[side=right]:sm:max-w-2xl overflow-y-auto"
      >
        <SheetHeader>
          <div className="flex items-center gap-2 pr-10">
            <SheetTitle className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
              {code && <span className="font-mono">{code}</span>}
              <span className="font-medium text-foreground">{title}</span>
            </SheetTitle>
          </div>
        </SheetHeader>

        <div className="space-y-4 px-4 pb-4">
          {/* Details — inline-editable fields. Each persists on blur/change. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {fields.map((f) => (
              <DrawerField
                key={f.key}
                field={f}
                value={values[f.key] ?? null}
                onLocalChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
                onCommit={(v) =>
                  void patchField(
                    f.key,
                    v,
                    f.coerce && typeof v === "string" ? f.coerce(v) : v,
                  )
                }
              />
            ))}
          </div>

          <Separator />

          {/* Comments / Activity toggle (matches the work-item detail toggle). */}
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setTab("comments")}
              className={cn(
                "flex items-center gap-1.5 border-b-2 pb-1 text-sm transition-colors",
                tab === "comments"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              Comments ({comments.length})
            </button>
            <button
              type="button"
              onClick={() => setTab("activity")}
              className={cn(
                "flex items-center gap-1.5 border-b-2 pb-1 text-sm transition-colors",
                tab === "activity"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <History className="h-3.5 w-3.5" />
              Activity ({activities.length})
            </button>
          </div>

          {/* Comments tab */}
          {tab === "comments" && (
            <div className="space-y-3">
              {comments.length === 0 && (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  No comments yet
                </p>
              )}
              {comments.map((c) => {
                const name = c.authorName ?? "Unknown";
                const isEditing = editingCommentId === c.id;
                const edited = !!c.updatedAt && c.updatedAt !== c.createdAt;
                return (
                  <div key={c.id} className="group/comment flex gap-2">
                    <Avatar size="sm">
                      {c.authorAvatarUrl && <AvatarImage src={c.authorAvatarUrl} alt="" />}
                      <AvatarFallback>{name.charAt(0).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium">{name}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {relativeTime(c.createdAt)}
                          {edited ? " · edited" : ""}
                        </span>
                        {!isEditing && (c.canEdit || c.canDelete) && (
                          <span className="ml-auto flex items-center gap-1.5 opacity-0 transition-opacity group-hover/comment:opacity-100">
                            {c.canEdit && (
                              <button
                                type="button"
                                aria-label="Edit comment"
                                className="text-muted-foreground hover:text-foreground"
                                onClick={() => {
                                  setEditingCommentId(c.id);
                                  setEditDraft(c.content);
                                }}
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                            )}
                            {c.canDelete && (
                              <button
                                type="button"
                                aria-label="Delete comment"
                                className="text-muted-foreground hover:text-destructive"
                                onClick={() => void handleDeleteComment(c.id)}
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            )}
                          </span>
                        )}
                      </div>
                      {isEditing ? (
                        <div className="mt-1 space-y-1.5">
                          <Textarea
                            value={editDraft}
                            onChange={(e) => setEditDraft(e.target.value)}
                            className="min-h-16 resize-none text-sm"
                          />
                          <div className="flex items-center gap-2">
                            <Button
                              size="xs"
                              onClick={() => void handleSaveCommentEdit(c.id)}
                              disabled={!editDraft.trim()}
                            >
                              Save
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => {
                                setEditingCommentId(null);
                                setEditDraft("");
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">
                          {renderCommentBody(c.content, members)}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}

              <div className="relative flex gap-2">
                <textarea
                  ref={composerRef}
                  rows={1}
                  value={newComment}
                  onChange={onComposerChange}
                  onKeyDown={onComposerKey}
                  placeholder="Write a comment… (@ to mention)"
                  className="flex-1 resize-none rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Post comment"
                  onClick={() => void handlePostComment()}
                  disabled={!newComment.trim() || posting}
                >
                  <Send className="h-4 w-4" />
                </Button>
                {mentionState && members.length > 0 && (
                  <MentionPicker
                    query={mentionState.q}
                    anchor={mentionState.anchor}
                    members={members}
                    onPick={pickMention}
                    onCancel={() => setMentionState(null)}
                  />
                )}
              </div>
            </div>
          )}

          {/* Activity tab — readable lines with relative timestamps. */}
          {tab === "activity" && (
            <div className="space-y-2">
              {activities.length === 0 && (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  No activity yet
                </p>
              )}
              {activities.map((a) => (
                <div
                  key={a.id}
                  className="flex items-start gap-2 py-1 text-xs text-muted-foreground"
                >
                  <History className="mt-0.5 h-3 w-3 shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">
                      {a.userName ?? "Someone"}
                    </span>{" "}
                    <ActivityVerb activity={a} />
                    <span className="ml-2 text-[10px]">{relativeTime(a.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** One activity line's verb phrase: created / commented / field change. */
function ActivityVerb({ activity: a }: { activity: PmActivity }) {
  if (a.action === "created") return <>created this</>;
  if (a.action === "commented") return <>commented</>;
  if (a.action === "updated" && a.field) {
    return (
      <>
        changed <span className="font-medium">{a.field}</span>
        {a.oldValue ? (
          <>
            : <span className="line-through">{a.oldValue}</span> →{" "}
            <span className="font-medium text-foreground">{a.newValue ?? "—"}</span>
          </>
        ) : (
          a.newValue && (
            <>
              {" "}
              to <span className="font-medium text-foreground">{a.newValue}</span>
            </>
          )
        )}
      </>
    );
  }
  // Fallback for any other action verb.
  return <>{a.action}</>;
}

/** Render the right inline editor per field type; read-only → static text. */
function DrawerField({
  field,
  value,
  onLocalChange,
  onCommit,
}: {
  field: PmField;
  value: string | number | null;
  onLocalChange: (v: string | number | null) => void;
  onCommit: (v: string | number | null) => void;
}) {
  const isFull = field.type === "textarea";
  return (
    <div className={cn("space-y-1", isFull && "sm:col-span-2")}>
      <label className="text-xs text-muted-foreground">{field.label}</label>
      {!field.editable ? (
        <div className="flex min-h-7 items-center text-sm text-[var(--text)]">
          {value === null || value === "" ? "—" : String(value)}
        </div>
      ) : field.type === "select" ? (
        <Select
          value={value == null ? "" : String(value)}
          onValueChange={(v) => onCommit(v ?? "")}
        >
          <SelectTrigger size="sm" aria-label={field.label} className="w-full text-xs">
            <SelectValue placeholder={field.placeholder ?? "Select…"} />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === "textarea" ? (
        <Textarea
          value={value == null ? "" : String(value)}
          onChange={(e) => onLocalChange(e.target.value)}
          onBlur={(e) => onCommit(e.target.value.trim() === "" ? null : e.target.value)}
          placeholder={field.placeholder}
          rows={3}
          className="resize-none text-sm"
        />
      ) : field.type === "number" ? (
        <Input
          type="number"
          min={field.min}
          max={field.max}
          value={value == null ? "" : String(value)}
          onChange={(e) => onLocalChange(e.target.value === "" ? null : Number(e.target.value))}
          onBlur={(e) => onCommit(e.target.value === "" ? null : Number(e.target.value))}
          className="h-7 text-xs"
          placeholder={field.placeholder ?? "-"}
        />
      ) : field.type === "date" ? (
        <DatePicker
          value={
            value
              ? String(value).length > 10
                ? new Date(String(value)).toISOString().slice(0, 10)
                : String(value)
              : ""
          }
          onValueChange={(val) =>
            onCommit(val ? new Date(val + "T00:00:00Z").toISOString() : null)
          }
          aria-label={field.label}
          className="h-7 text-xs"
        />
      ) : (
        <Input
          value={value == null ? "" : String(value)}
          onChange={(e) => onLocalChange(e.target.value)}
          onBlur={(e) => onCommit(e.target.value.trim() === "" ? null : e.target.value)}
          placeholder={field.placeholder}
          className="h-7 text-xs"
        />
      )}
    </div>
  );
}
