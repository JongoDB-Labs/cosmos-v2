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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DatePicker } from "@/components/ui/date-picker";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { notifyError } from "@/lib/errors/notify";
import { usePermissions } from "@/components/providers/permissions-provider";
import { Permission } from "@/lib/rbac/permissions";
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
  Copy,
  Trash2,
  GitBranch,
  CornerDownRight,
  Plus,
} from "lucide-react";
import type {
  WorkItem,
  WorkItemRef,
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
  /** Remove the item from the parent's local state after a successful delete. */
  onDelete?: (id: string) => void;
  /** Append a freshly-duplicated item to the parent's local state. */
  onDuplicate?: (created: WorkItem) => void;
  /** Candidate parents for the hierarchy picker (the project's items). When
   *  omitted, the Parent picker is hidden (the Children list still shows). */
  projectItems?: WorkItem[];
  /** Add a newly-created sub-item to the parent's local state (no auto-open). */
  onItemCreated?: (created: WorkItem) => void;
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
  onDelete,
  onDuplicate,
  projectItems,
  onItemCreated,
}: CardDetailSheetProps) {
  const { can } = usePermissions();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionPending, setActionPending] = useState<null | "delete" | "duplicate">(null);
  const [parentId, setParentId] = useState<string | null>(null);
  const [children, setChildren] = useState<WorkItemRef[]>([]);
  const [childTitle, setChildTitle] = useState("");
  const [addingChild, setAddingChild] = useState(false);
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
      setParentId(item.parentId);
      setChildren(item.children ?? []);
      setChildTitle("");
      setDirty(false);
      setConfirmDelete(false);
      setActionPending(null);
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
          case "parentId":
            setParentId(item.parentId);
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
      case "parentId":
        setParentId(value as string | null);
        break;
    }
    // Fire PUT request immediately
    void patchField(field, value);
  }

  // Create a sub-item under the current item (FR: story/task hierarchy). Starts
  // in the same column as its parent; the new id is added to the local children
  // list and surfaced to the board via onItemCreated (without stealing focus).
  async function handleAddChild() {
    const trimmed = childTitle.trim();
    if (!item || !trimmed) return;
    setAddingChild(true);
    try {
      const res = await fetch(basePath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: trimmed,
          type: "TASK",
          columnKey: item.columnKey,
          parentId: item.id,
        }),
      });
      if (!res.ok) throw new Error(`Failed to add sub-item (HTTP ${res.status})`);
      const child: WorkItem = await res.json();
      setChildren((prev) => [
        ...prev,
        {
          id: child.id,
          title: child.title,
          ticketNumber: child.ticketNumber,
          workItemTypeId: child.workItemTypeId,
          columnKey: child.columnKey,
        },
      ]);
      setChildTitle("");
      onItemCreated?.(child);
    } catch (err) {
      notifyError(err, "Couldn't add the sub-item.");
    } finally {
      setAddingChild(false);
    }
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

  async function handleDuplicate() {
    if (!item) return;
    setActionPending("duplicate");
    try {
      const res = await fetch(`${basePath}/${item.id}/duplicate`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`Failed to duplicate (HTTP ${res.status})`);
      const dupe: WorkItem = await res.json();
      onDuplicate?.(dupe);
    } catch (err) {
      notifyError(err, "Couldn't duplicate this item.");
    } finally {
      setActionPending(null);
    }
  }

  async function handleDelete() {
    if (!item) return;
    setActionPending("delete");
    try {
      const res = await fetch(`${basePath}/${item.id}`, { method: "DELETE" });
      // DELETE returns 204; a raw fetch doesn't reject on non-2xx.
      if (!res.ok) throw new Error(`Failed to delete (HTTP ${res.status})`);
      const deletedId = item.id;
      setConfirmDelete(false);
      onOpenChange(false);
      onDelete?.(deletedId);
    } catch (err) {
      notifyError(err, "Couldn't delete this item.");
    } finally {
      setActionPending(null);
    }
  }

  if (!item) return null;

  const canDuplicate = can(Permission.ITEM_CREATE);
  const canDelete = can(Permission.ITEM_DELETE);

  // Candidate parents: every other item in the project, minus this item's own
  // direct children (a shallow guard against the most obvious parent/child
  // cycle; the server still owns deeper integrity).
  const childIds = new Set(children.map((c) => c.id));
  const parentCandidates = (projectItems ?? []).filter(
    (p) => p.id !== item.id && !childIds.has(p.id),
  );

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
              editable input below — not duplicated here. Item-level actions
              (duplicate / delete) sit on the right, each permission-gated. */}
          <div className="flex items-center justify-between gap-2 pr-8">
            <SheetTitle className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
              <span className="font-mono">#{item.ticketNumber}</span>
              {item.workItemType && (
                <span className="rounded px-1.5 py-0.5 font-medium bg-muted text-muted-foreground">
                  {item.workItemType.name}
                </span>
              )}
            </SheetTitle>
            {(canDuplicate || canDelete) && (
              <div className="flex items-center gap-1">
                {canDuplicate && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-muted-foreground"
                    onClick={handleDuplicate}
                    disabled={actionPending !== null}
                  >
                    {actionPending === "duplicate" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    Duplicate
                  </Button>
                )}
                {canDelete && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-destructive hover:text-destructive"
                    onClick={() => setConfirmDelete(true)}
                    disabled={actionPending !== null}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </Button>
                )}
              </div>
            )}
          </div>
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

            {projectItems && (
              <MetadataField icon={GitBranch} label="Parent">
                <Select
                  items={{
                    __none__: "None",
                    ...Object.fromEntries(
                      parentCandidates.map((p) => [
                        p.id,
                        `#${p.ticketNumber} ${p.title}`,
                      ]),
                    ),
                  }}
                  value={parentId ?? "__none__"}
                  onValueChange={(v) =>
                    handleFieldChange(
                      "parentId",
                      (v === "__none__" ? null : v) as string | null,
                    )
                  }
                >
                  <SelectTrigger size="sm" aria-label="Parent" className="w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {parentCandidates.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        #{p.ticketNumber} {p.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </MetadataField>
            )}
          </div>

          {/* Sub-items (hierarchy). Shows existing children + an inline create;
              creating one POSTs a TASK with parentId preset to this item. */}
          {(children.length > 0 || canDuplicate) && (
            <>
              <Separator />
              <div className="space-y-2">
                <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <CornerDownRight className="h-3.5 w-3.5" />
                  Sub-items ({children.length})
                </h3>
                {children.map((c) => (
                  <div key={c.id} className="flex items-center gap-2 text-sm">
                    <span className="font-mono text-[11px] text-muted-foreground shrink-0">
                      #{c.ticketNumber}
                    </span>
                    <span className="truncate">{c.title}</span>
                  </div>
                ))}
                {canDuplicate && (
                  <div className="flex gap-2">
                    <Input
                      value={childTitle}
                      onChange={(e) => setChildTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleAddChild();
                        }
                      }}
                      placeholder="Add a sub-item…"
                      className="h-7 text-xs"
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1.5"
                      onClick={handleAddChild}
                      disabled={!childTitle.trim() || addingChild}
                    >
                      {addingChild ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Plus className="h-3.5 w-3.5" />
                      )}
                      Add
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}

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

      <Dialog
        open={confirmDelete}
        onOpenChange={(o) => {
          if (!o) setConfirmDelete(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete work item?</DialogTitle>
            <DialogDescription>
              This will permanently delete #{item.ticketNumber}
              {item.title ? ` "${item.title}"` : ""}. This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              disabled={actionPending === "delete"}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={actionPending === "delete"}
            >
              {actionPending === "delete" ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
