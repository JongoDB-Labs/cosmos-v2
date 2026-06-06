"use client";

import { useState, useEffect, useTransition, useCallback, useRef } from "react";
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { notifyError } from "@/lib/errors/notify";
import { MentionPicker, useOrgMembers } from "@/components/chat/mention-typeahead";
import {
  MessageSquare,
  History,
  Send,
  Loader2,
  Calendar,
  User,
  Tag,
  Layers,
  Target,
  Hash,
  Check,
} from "lucide-react";
import type {
  WorkItem,
  OrgMember,
  Cycle,
  Comment,
  Activity,
  BoardColumn,
} from "@/types/models";

interface CardDetailSheetProps {
  item: WorkItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  projectId: string;
  members: OrgMember[];
  cycles: Cycle[];
  columns: BoardColumn[];
  onUpdate: (updated: WorkItem) => void;
}

const priorityOptions = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

export function CardDetailSheet({
  item,
  open,
  onOpenChange,
  orgId,
  projectId,
  members,
  cycles,
  columns,
  onUpdate,
}: CardDetailSheetProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<WorkItem["priority"]>("MEDIUM");
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [cycleId, setCycleId] = useState<string | null>(null);
  const [columnKey, setColumnKey] = useState("");
  const [storyPoints, setStoryPoints] = useState<number | null>(null);
  const [dueDate, setDueDate] = useState<string>("");

  const [tab, setTab] = useState<"comments" | "activity">("comments");
  const [comments, setComments] = useState<Comment[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [newComment, setNewComment] = useState("");
  const [isPending, startTransition] = useTransition();
  const [dirty, setDirty] = useState(false);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const [mentionState, setMentionState] = useState<{
    q: string;
    anchor: { top: number; left: number };
  } | null>(null);
  const { data: mentionMembers } = useOrgMembers(orgId);

  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}/work-items`;

  // Sync form with item — this is an intentional "derive state from prop"
  // pattern; the effect fires only when `item` reference changes.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (item) {
      setTitle(item.title);
      setDescription(item.description);
      setPriority(item.priority);
      setAssigneeId(item.assigneeId);
      setCycleId(item.cycleId);
      setColumnKey(item.columnKey);
      setStoryPoints(item.storyPoints);
      setDueDate(item.dueDate ? item.dueDate.split("T")[0] : "");
      setDirty(false);
    }
  }, [item]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Fetch comments/activity when item changes
  useEffect(() => {
    if (!item || !open) return;
    let cancelled = false;

    async function load() {
      try {
        const [commentsRes, activityRes] = await Promise.all([
          fetch(`${basePath}/${item!.id}/comments`),
          fetch(`${basePath}/${item!.id}/activity`),
        ]);
        if (cancelled) return;
        if (commentsRes.ok) setComments(await commentsRes.json());
        if (activityRes.ok) setActivities(await activityRes.json());
      } catch {
        // Silently handle - comments/activity are optional
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [item, open, basePath]);

  // Immediately persist a single field change via PUT and update parent cache.
  const patchField = useCallback(
    async (field: string, value: unknown) => {
      if (!item) return;
      const prevColumnKey = item.columnKey;
      try {
        const res = await fetch(`${basePath}/${item.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [field]: value }),
        });
        if (!res.ok) throw new Error("Failed to update");
        const updated: WorkItem = await res.json();
        onUpdate(updated);

        // Fire confetti when item moves into a DONE column
        if (field === "columnKey" && typeof value === "string") {
          const isDoneColumn = (key: string) =>
            ["done", "completed", "closed"].some((k) =>
              key.toLowerCase().includes(k)
            );
          if (
            value !== prevColumnKey &&
            isDoneColumn(value) &&
            !isDoneColumn(prevColumnKey) &&
            updated.workItemType?.celebrateOnComplete
          ) {
            void import("@/lib/confetti").then(({ celebrate }) => celebrate());
          }
        }
      } catch (err) {
        console.error(`Failed to patch ${field}:`, err);
        // Revert ONLY the field that failed back to the server value (`item` is
        // unchanged on failure since onUpdate runs only on success). Reverting
        // every field would clobber other concurrent/just-succeeded edits.
        switch (field) {
          case "priority":
            setPriority(item.priority);
            break;
          case "assigneeId":
            setAssigneeId(item.assigneeId);
            break;
          case "cycleId":
            setCycleId(item.cycleId);
            break;
          case "columnKey":
            setColumnKey(item.columnKey);
            break;
          case "storyPoints":
            setStoryPoints(item.storyPoints);
            break;
          case "dueDate":
            setDueDate(item.dueDate ? item.dueDate.split("T")[0] : "");
            break;
        }
        notifyError(err, "Couldn't save the change.");
      }
    },
    [item, basePath, onUpdate]
  );

  function handleFieldChange<K extends keyof WorkItem>(
    field: K,
    value: WorkItem[K]
  ) {
    // Update local state immediately for responsive UI
    switch (field) {
      case "priority":
        setPriority(value as WorkItem["priority"]);
        break;
      case "assigneeId":
        setAssigneeId(value as string | null);
        break;
      case "cycleId":
        setCycleId(value as string | null);
        break;
      case "columnKey":
        setColumnKey(value as string);
        break;
      case "storyPoints":
        setStoryPoints(value as number | null);
        break;
    }
    // Fire PUT request immediately
    void patchField(field, value);
  }

  // handleSave persists title/description (free-text fields that don't auto-save
  // on each keystroke).
  function handleSave() {
    if (!item) return;
    startTransition(async () => {
      try {
        const res = await fetch(`${basePath}/${item.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, description }),
        });
        if (!res.ok) throw new Error("Failed to update");
        const updated: WorkItem = await res.json();
        onUpdate(updated);
        setDirty(false);
      } catch (err) {
        console.error("Failed to save:", err);
        notifyError(err, "Couldn't save your changes.");
      }
    });
  }

  function detectMention(text: string, caret: number) {
    const before = text.slice(0, caret);
    const m = before.match(/(?:^|\s)@([\w-]*)$/);
    if (!m) return null;
    return m[1];
  }

  function onCommentChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setNewComment(e.target.value);
    const q = detectMention(e.target.value, e.target.selectionStart ?? 0);
    if (q !== null) {
      const rect = e.target.getBoundingClientRect();
      setMentionState({
        q,
        anchor: { top: rect.top - 8 - 200, left: rect.left + 32 },
      });
    } else {
      setMentionState(null);
    }
  }

  function pickMention(user: { id: string; displayName: string }) {
    const ta = commentRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? newComment.length;
    const before = newComment
      .slice(0, caret)
      .replace(/(?:^|\s)@([\w-]*)$/, (m) =>
        m.replace(/@[\w-]*$/, `<@${user.id}>`)
      );
    const after = newComment.slice(caret);
    setNewComment(before + after);
    setMentionState(null);
    requestAnimationFrame(() => ta.focus());
  }

  function onCommentKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionState) return; // let MentionPicker handle ArrowUp/Down/Enter/Escape
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAddComment();
    }
  }

  function handleAddComment() {
    if (!item || !newComment.trim()) return;
    startTransition(async () => {
      try {
        const res = await fetch(`${basePath}/${item.id}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: newComment.trim() }),
        });
        if (!res.ok) throw new Error("Failed to add comment");
        const comment: Comment = await res.json();
        setComments((prev) => [...prev, comment]);
        setNewComment("");
      } catch (err) {
        console.error("Failed to add comment:", err);
        notifyError(err, "Couldn't post your comment.");
      }
    });
  }

  if (!item) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        // Match the base Sheet's data-[side=right] width variants so twMerge
        // actually overrides them — a plain `w-full` loses to the base
        // `data-[side=right]:w-3/4`, leaving the sheet at 75% on mobile.
        className="data-[side=right]:w-full data-[side=right]:sm:max-w-2xl overflow-y-auto"
      >
        <SheetHeader>
          {/* Single identity line: "#1 · Task". The title is shown once, in the
              editable input below — not duplicated here. */}
          <SheetTitle className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
            <span className="font-mono">#{item.ticketNumber}</span>
            {item.workItemType && (
              <span className="rounded px-1.5 py-0.5 font-medium bg-muted text-muted-foreground">
                {item.workItemType.name}
              </span>
            )}
          </SheetTitle>
        </SheetHeader>

        <div className="px-4 pb-4 space-y-4">
          {/* Title — an auto-sizing textarea (not a single-line input) so long
              titles wrap across lines and stay fully visible instead of
              clipping to the scrolled tail. `field-sizing-content` grows the
              height to fit the wrapped text reactively (no JS measurement,
              correct even while the sheet animates in / the width settles). */}
          <textarea
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setDirty(true);
            }}
            rows={1}
            className="w-full resize-none overflow-hidden bg-transparent text-lg font-semibold leading-snug outline-none field-sizing-content placeholder:text-muted-foreground"
            placeholder="Title"
          />

          {/* Description */}
          <Textarea
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setDirty(true);
            }}
            placeholder="Add a description..."
            className="min-h-20 resize-none"
          />

          <Separator />

          {/* Metadata grid */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <MetadataField icon={Tag} label="Type">
              <span className="text-xs px-2 py-1">
                {item.workItemType?.name ?? "Unknown"}
              </span>
            </MetadataField>

            <MetadataField icon={Layers} label="Status">
              <Select
                items={Object.fromEntries(columns.map((c) => [c.key, c.name]))}
                value={columnKey}
                onValueChange={(v) => handleFieldChange("columnKey", v ?? "")}
              >
                <SelectTrigger size="sm" aria-label="Status" className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {columns.map((c) => (
                    <SelectItem key={c.key} value={c.key}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </MetadataField>

            <MetadataField icon={Target} label="Priority">
              <Select
                items={Object.fromEntries(
                  priorityOptions.map((p) => [
                    p,
                    p.charAt(0) + p.slice(1).toLowerCase(),
                  ]),
                )}
                value={priority}
                onValueChange={(v) =>
                  handleFieldChange("priority", v as WorkItem["priority"])
                }
              >
                <SelectTrigger size="sm" aria-label="Priority" className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {priorityOptions.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p.charAt(0) + p.slice(1).toLowerCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </MetadataField>

            <MetadataField icon={User} label="Assignee">
              <Select
                items={{
                  __unassigned__: "Unassigned",
                  ...Object.fromEntries(
                    members.map((m) => [
                      m.userId,
                      m.user?.displayName ?? m.userId,
                    ]),
                  ),
                }}
                value={assigneeId ?? "__unassigned__"}
                onValueChange={(v) =>
                  handleFieldChange(
                    "assigneeId",
                    (v === "__unassigned__" ? null : v) as string | null
                  )
                }
              >
                <SelectTrigger size="sm" aria-label="Assignee" className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__unassigned__">Unassigned</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.userId} value={m.userId}>
                      {m.user?.displayName ?? m.userId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </MetadataField>

            <MetadataField icon={Hash} label="Points">
              <Input
                type="number"
                min={0}
                value={storyPoints ?? ""}
                onChange={(e) => {
                  const val = e.target.value
                    ? parseInt(e.target.value, 10)
                    : null;
                  handleFieldChange("storyPoints", val);
                }}
                className="h-7 text-xs"
                placeholder="-"
              />
            </MetadataField>

            <MetadataField icon={Calendar} label="Due date">
              <DatePicker
                value={dueDate}
                onValueChange={(val) => {
                  setDueDate(val);
                  // Convert date string to ISO datetime for the API, or null to clear
                  const isoVal = val
                    ? new Date(val + "T00:00:00Z").toISOString()
                    : null;
                  void patchField("dueDate", isoVal);
                }}
                aria-label="Due date"
                className="h-7 text-xs"
              />
            </MetadataField>

            {cycles.length > 0 && (
              <MetadataField icon={Target} label="Cycle">
                <Select
                  items={{
                    __none__: "None",
                    ...Object.fromEntries(cycles.map((s) => [s.id, s.name])),
                  }}
                  value={cycleId ?? "__none__"}
                  onValueChange={(v) =>
                    handleFieldChange(
                      "cycleId",
                      (v === "__none__" ? null : v) as string | null
                    )
                  }
                >
                  <SelectTrigger size="sm" aria-label="Cycle" className="w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {cycles.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </MetadataField>
            )}
          </div>

          {/* Make the save model explicit: metadata fields auto-save on change,
              while title/description need a Save. Show which state we're in. */}
          <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
            {dirty ? (
              <Button size="sm" onClick={handleSave} disabled={isPending}>
                {isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                ) : null}
                Save changes
              </Button>
            ) : (
              <span className="flex items-center gap-1">
                <Check className="h-3.5 w-3.5 text-[var(--status-done,green)]" />
                All changes saved
              </span>
            )}
          </div>

          <Separator />

          {/* Comments / Activity toggle */}
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setTab("comments")}
              className={cn(
                "flex items-center gap-1.5 text-sm pb-1 border-b-2 transition-colors",
                tab === "comments"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              Comments ({comments.length})
            </button>
            <button
              type="button"
              onClick={() => setTab("activity")}
              className={cn(
                "flex items-center gap-1.5 text-sm pb-1 border-b-2 transition-colors",
                tab === "activity"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
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
                <p className="text-xs text-muted-foreground py-4 text-center">
                  No comments yet
                </p>
              )}
              {comments.map((c) => (
                <div key={c.id} className="flex gap-2">
                  <Avatar size="sm">
                    <AvatarFallback>
                      {(c.author?.user?.displayName ?? "?")
                        .charAt(0)
                        .toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">
                        {c.author?.user?.displayName ?? "Unknown"}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {new Date(c.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      {c.content}
                    </p>
                  </div>
                </div>
              ))}

              <div className="relative flex gap-2">
                <textarea
                  ref={commentRef}
                  rows={1}
                  value={newComment}
                  onChange={onCommentChange}
                  onKeyDown={onCommentKey}
                  placeholder="Write a comment… (@ to mention)"
                  className="flex-1 resize-none rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Add comment"
                  onClick={handleAddComment}
                  disabled={!newComment.trim() || isPending}
                >
                  <Send className="h-4 w-4" />
                </Button>
                {mentionState && mentionMembers && (
                  <MentionPicker
                    query={mentionState.q}
                    anchor={mentionState.anchor}
                    members={mentionMembers}
                    onPick={pickMention}
                    onCancel={() => setMentionState(null)}
                  />
                )}
              </div>
            </div>
          )}

          {/* Activity tab */}
          {tab === "activity" && (
            <div className="space-y-2">
              {activities.length === 0 && (
                <p className="text-xs text-muted-foreground py-4 text-center">
                  No activity yet
                </p>
              )}
              {activities.map((a) => (
                <div
                  key={a.id}
                  className="flex items-start gap-2 text-xs text-muted-foreground py-1"
                >
                  <History className="h-3 w-3 mt-0.5 shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">
                      {a.action}
                    </span>
                    {a.field && (
                      <>
                        {" "}
                        changed <span className="font-medium">{a.field}</span>
                        {a.oldValue && (
                          <>
                            {" "}
                            from{" "}
                            <span className="line-through">{a.oldValue}</span>
                          </>
                        )}
                        {a.newValue && (
                          <>
                            {" "}
                            to{" "}
                            <span className="font-medium">{a.newValue}</span>
                          </>
                        )}
                      </>
                    )}
                    <span className="ml-2 text-[10px]">
                      {new Date(a.createdAt).toLocaleDateString()}
                    </span>
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

function MetadataField({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </label>
      {children}
    </div>
  );
}
