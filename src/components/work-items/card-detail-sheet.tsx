"use client";

import { useState, useEffect, useTransition, useCallback, useMemo, useRef } from "react";
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
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
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
import { useOrgMembers } from "@/components/chat/mention-typeahead";
import { EntityMentionPicker } from "@/components/mentions/entity-mention-picker";
import { useRefResolver } from "@/components/mentions/hooks";
import { MarkdownContent } from "@/components/chat/markdown-content";
import { MentionedIn } from "@/components/mentions/mentioned-in";
import { insertMentionToken } from "@/lib/mentions/input";
import { refKey, type ResolvedEntity } from "@/lib/mentions/refs";
import { WorkItemLinksSection } from "@/components/work-items/links-section";
import { RoadmapDescriptionField } from "@/components/roadmap/roadmap-description-field";
import { WorkItemDocumentSource } from "@/components/files/work-item-document-source";
import { useCustomFields, fieldAppliesToType } from "@/hooks/use-custom-fields";
import {
  CustomFieldInput,
  isRenderableCustomField,
} from "@/components/work-items/custom-field-input";
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
  Wrench,
  Check,
  Copy,
  Star,
  Trash2,
  GitBranch,
  CornerDownRight,
  GripVertical,
  Plus,
  Pencil,
  X,
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
import {
  activityFieldLabel,
  activityValueLabel,
} from "@/lib/work-items/activity-label";

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
  /** Sub-items were drag-reordered (their sortOrder changed). Lets a parent view
   *  refresh so date-independent order surfaces (e.g. the Timeline/Gantt). */
  onChildrenReordered?: () => void;
  /** Open another work item (sub-item or linked item) in this same sheet. */
  onOpenItem?: (id: string) => void;
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
  onChildrenReordered,
  onOpenItem,
}: CardDetailSheetProps) {
  const { can } = usePermissions();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dupPrompt, setDupPrompt] = useState(false);
  const [dragChildIdx, setDragChildIdx] = useState<number | null>(null);
  const [actionPending, setActionPending] = useState<null | "delete" | "duplicate">(null);
  // Watch state (FR 8702c9b8) — fetched per item when the sheet opens.
  const [watching, setWatching] = useState(false);
  const [watchPending, setWatchPending] = useState(false);
  const [parentId, setParentId] = useState<string | null>(null);
  const [children, setChildren] = useState<WorkItemRef[]>([]);
  const [childTitle, setChildTitle] = useState("");
  const [addingChild, setAddingChild] = useState(false);
  // Guards the on-open server reconcile (below) against clobbering a sub-item the
  // user has just added / removed / reordered locally while the GET is in flight.
  const childrenTouched = useRef(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<WorkItem["priority"]>("MEDIUM");
  // SAFe classification (FR gantt-enh): business value vs. enabler work.
  const [workCategory, setWorkCategory] = useState<WorkItem["workCategory"]>("BUSINESS");
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  // Multi-assign (FR 1d38496a): the full set, primary first. assigneeId above
  // mirrors the set's head so single-assignee displays stay consistent.
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [cycleId, setCycleId] = useState<string | null>(null);
  const [columnKey, setColumnKey] = useState("");
  const [storyPoints, setStoryPoints] = useState<number | null>(null);
  const [startDate, setStartDate] = useState<string>("");
  const [dueDate, setDueDate] = useState<string>("");

  const [tab, setTab] = useState<"comments" | "activity">("comments");
  const [comments, setComments] = useState<Comment[]>([]);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
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
  // Person chips resolve instantly from the member map; other entity chips via
  // the batch resolver. Comments render markdown (was raw text — now chips).
  const commentUserSeed = useMemo(() => {
    const m = new Map<string, ResolvedEntity>();
    for (const u of mentionMembers ?? [])
      m.set(refKey("user", u.id), { type: "user", id: u.id, label: u.displayName, url: null });
    return m;
  }, [mentionMembers]);
  const commentRefMap = useRefResolver(
    orgId,
    comments.map((c) => c.content),
    commentUserSeed,
  );
  // Resolve id-valued activity fields (assignee/cycle/status) to names so the
  // Activity tab never shows a raw GUID (FR 545f81b1).
  const activityResolvers = useMemo(
    () => ({
      user: (id: string) => members.find((m) => m.userId === id)?.user?.displayName,
      cycle: (id: string) => cycles.find((c) => c.id === id)?.name,
      column: (key: string) => columns.find((c) => c.key === key)?.name,
    }),
    [members, cycles, columns],
  );
  // Custom-field defs for this project (org-wide + project-scoped), narrowed to
  // the fields that apply to THIS item's work-item type (type bindings honored).
  const { fields: customFields } = useCustomFields(orgId, projectId);
  const itemCustomFields = customFields.filter(
    (f) =>
      isRenderableCustomField(f) &&
      fieldAppliesToType(f, item?.workItemTypeId),
  );

  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}/work-items`;

  // Sync form with item — this is an intentional "derive state from prop"
  // pattern; the effect fires only when `item` reference changes.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (item) {
      setTitle(item.title);
      setDescription(item.description);
      setPriority(item.priority);
      setWorkCategory(item.workCategory ?? "BUSINESS");
      setAssigneeId(item.assigneeId);
      setAssigneeIds(
        item.assignees?.map((a) => a.userId) ??
          (item.assigneeId ? [item.assigneeId] : []),
      );
      setCycleId(item.cycleId);
      setColumnKey(item.columnKey);
      setStoryPoints(item.storyPoints);
      setStartDate(item.startDate ? item.startDate.split("T")[0] : "");
      setDueDate(item.dueDate ? item.dueDate.split("T")[0] : "");
      setParentId(item.parentId);
      setChildren(item.children ?? []);
      setChildTitle("");
      setDirty(false);
      setConfirmDelete(false);
      setActionPending(null);
      // Reset per-item interaction state too, so switching items (via duplicate,
      // a linked-item/sub-item click, or board navigation) never carries a draft
      // comment, an open comment-edit, or the Activity tab over to the next item
      // — a stale `newComment` could otherwise be posted to the WRONG work item.
      setNewComment("");
      setTab("comments");
      setEditingCommentId(null);
      setEditDraft("");
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

  // Reconcile the Sub-items list against server-persisted state whenever the
  // sheet opens an item (COSMOS-92). The `item.children` we're handed can be
  // stale: different surfaces populate it from different reads (a list GET, a
  // POST/PUT echo, a single-item GET), and a parent reopened after navigating
  // into one of its sub-items can carry an out-of-date children array — so a
  // subtask that still exists silently drops out of the parent's list until a
  // manual page refresh. The single-item GET returns the authoritative children
  // (id/title/ticketNumber/columnKey); apply them unless the user has already
  // changed the list locally this session (childrenTouched), so an in-flight GET
  // can't clobber a just-added/removed/reordered sub-item. Keyed on item.id (not
  // the object) so an unrelated onUpdate re-render doesn't refire it.
  useEffect(() => {
    if (!item || !open) return;
    childrenTouched.current = false;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${basePath}/${item.id}`);
        if (!res.ok) return;
        const full = await res.json();
        const serverChildren = (full?.children ?? full?.data?.children) as
          | WorkItemRef[]
          | undefined;
        if (cancelled || childrenTouched.current || !Array.isArray(serverChildren)) return;
        setChildren(serverChildren);
      } catch {
        // Best-effort reconcile — the prop-derived list stays as the fallback.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, open, basePath]);

  // Watch state (FR 8702c9b8) — read whether the current user follows this item.
  // `watchTouched` guards against a late on-open GET clobbering a fast toggle.
  const watchTouched = useRef(false);
  useEffect(() => {
    if (!item || !open) return;
    watchTouched.current = false;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${basePath}/${item.id}/watch`);
        if (!cancelled && !watchTouched.current && res.ok) {
          const data = (await res.json()) as { watching: boolean };
          setWatching(data.watching);
        }
      } catch {
        /* watch state is non-critical */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item, open, basePath]);

  const toggleWatch = useCallback(async () => {
    if (!item || watchPending) return;
    watchTouched.current = true;
    const next = !watching;
    setWatching(next); // optimistic
    setWatchPending(true);
    try {
      const res = await fetch(`${basePath}/${item.id}/watch`, {
        method: next ? "POST" : "DELETE",
      });
      if (!res.ok) throw new Error("Failed");
    } catch (err) {
      setWatching(!next); // revert
      notifyError(err, "Couldn't update watch state.");
    } finally {
      setWatchPending(false);
    }
  }, [item, watching, watchPending, basePath]);

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

        // Re-parenting also changes BOTH parents' `children` arrays, but the PUT
        // response only carries the child — without this the new parent's
        // Sub-items list stays stale until a full refetch (BR 7d1ae4d2). Patch
        // the old parent (drop the child) and the new parent (append a ref)
        // through the same map-replace onUpdate path the child uses.
        if (field === "parentId") {
          const oldParent = projectItems?.find((p) => p.id === item.parentId);
          if (oldParent) {
            onUpdate({
              ...oldParent,
              children: (oldParent.children ?? []).filter((c) => c.id !== item.id),
            });
          }
          const newParent =
            typeof value === "string"
              ? projectItems?.find((p) => p.id === value)
              : undefined;
          if (newParent && !(newParent.children ?? []).some((c) => c.id === item.id)) {
            onUpdate({
              ...newParent,
              children: [
                ...(newParent.children ?? []),
                {
                  id: updated.id,
                  title: updated.title,
                  ticketNumber: updated.ticketNumber,
                  workItemTypeId: updated.workItemTypeId,
                  columnKey: updated.columnKey,
                },
              ],
            });
          }
        }

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
          case "workCategory":
            setWorkCategory(item.workCategory ?? "BUSINESS");
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
          case "startDate":
            setStartDate(item.startDate ? item.startDate.split("T")[0] : "");
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
    [item, basePath, onUpdate, projectItems]
  );

  // Replace the assignee set (multi-assign). Optimistic; the first member
  // becomes the primary assigneeId server-side, mirrored locally.
  const patchAssignees = useCallback(
    async (next: string[]) => {
      if (!item) return;
      const prevSet = assigneeIds;
      const prevPrimary = assigneeId;
      setAssigneeIds(next);
      setAssigneeId(next[0] ?? null);
      try {
        const res = await fetch(`${basePath}/${item.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assigneeIds: next }),
        });
        if (!res.ok) throw new Error("Failed to update");
        const updated: WorkItem = await res.json();
        onUpdate(updated);
      } catch (err) {
        setAssigneeIds(prevSet);
        setAssigneeId(prevPrimary);
        notifyError(err, "Couldn't update assignees.");
      }
    },
    [item, basePath, onUpdate, assigneeIds, assigneeId],
  );

  // Persist a single custom-field value. The PUT route MERGES the customFields
  // patch into the item's existing JSON, so sending just the one key is safe —
  // other custom-field values are preserved server-side.
  const patchCustomField = useCallback(
    async (key: string, value: unknown) => {
      if (!item) return;
      try {
        const res = await fetch(`${basePath}/${item.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customFields: { [key]: value } }),
        });
        if (!res.ok) throw new Error("Failed to update");
        const updated: WorkItem = await res.json();
        onUpdate(updated);
      } catch (err) {
        console.error(`Failed to patch custom field ${key}:`, err);
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
      case "workCategory":
        setWorkCategory(value as WorkItem["workCategory"]);
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
          // FR 3fd0e9bd: default the sub-item's type one level down the
          // hierarchy from its parent (epic→story, story→task, task/bug→subtask)
          // instead of always TASK.
          type: childTypeFor(item.workItemType?.key),
          columnKey: item.columnKey,
          parentId: item.id,
        }),
      });
      if (!res.ok) throw new Error(`Failed to add sub-item (HTTP ${res.status})`);
      const child: WorkItem = await res.json();
      const childRef = {
        id: child.id,
        title: child.title,
        ticketNumber: child.ticketNumber,
        workItemTypeId: child.workItemTypeId,
        columnKey: child.columnKey,
      };
      childrenTouched.current = true;
      setChildren((prev) => [...prev, childRef]);
      setChildTitle("");
      // Keep the CACHED parent's children in sync too (same staleness class as
      // BR 7d1ae4d2) — otherwise reopening this parent reads the stale cache
      // and the new sub-item vanishes from the list until a refetch.
      onUpdate({ ...item, children: [...(item.children ?? []), childRef] });
      onItemCreated?.(child);
    } catch (err) {
      notifyError(err, "Couldn't add the sub-item.");
    } finally {
      setAddingChild(false);
    }
  }

  // Remove a sub-item from this parent by un-nesting it (parentId → null). The
  // item itself is kept — it just stops being a child here. Optimistic.
  async function handleRemoveChild(childId: string) {
    const prev = children;
    childrenTouched.current = true;
    setChildren((cs) => cs.filter((c) => c.id !== childId));
    try {
      const res = await fetch(`${basePath}/${childId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId: null }),
      });
      if (!res.ok) throw new Error(`Failed to remove sub-item (HTTP ${res.status})`);
      // Sync the cached parent's children (same staleness class as BR 7d1ae4d2).
      if (item) {
        onUpdate({
          ...item,
          children: (item.children ?? []).filter((c) => c.id !== childId),
        });
      }
    } catch (err) {
      setChildren(prev);
      notifyError(err, "Couldn't remove the sub-item.");
    }
  }

  // Drag-reorder sub-items (FR). Reorders the list optimistically, then persists
  // each item's new sortOrder (parallel PUTs); the server orders children by
  // sortOrder so the new order survives a reload. On success we also notify the
  // parent view so date-ordered surfaces (the Timeline/Gantt) can refresh to the
  // chosen order instead of waiting for the next refetch (FR COSMOS-5).
  async function reorderChildren(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return;
    const prev = children;
    const next = [...children];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    childrenTouched.current = true;
    setChildren(next);
    try {
      const results = await Promise.all(
        next.map((c, i) =>
          fetch(`${basePath}/${c.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sortOrder: i }),
          }),
        ),
      );
      if (results.some((r) => !r.ok)) throw new Error("Failed to reorder");
      onChildrenReordered?.();
    } catch (err) {
      setChildren(prev);
      notifyError(err, "Couldn't reorder the sub-items.");
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

  function pickEntity(hit: ResolvedEntity) {
    const ta = commentRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? newComment.length;
    const { value, caret: caretAfter } = insertMentionToken(
      newComment,
      caret,
      hit.type,
      hit.id,
    );
    setNewComment(value);
    setMentionState(null);
    // Restore the caret to just after the inserted mention (not the end of the
    // whole comment) so typing continues in place when mentioning mid-sentence.
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(caretAfter, caretAfter);
    });
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

  async function handleSaveCommentEdit(id: string) {
    const content = editDraft.trim();
    if (!content || !item) return;
    try {
      const res = await fetch(`${basePath}/${item.id}/comments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error(`Failed to edit comment (HTTP ${res.status})`);
      const updated: Comment = await res.json();
      setComments((prev) =>
        prev.map((c) => (c.id === id ? { ...c, content: updated.content } : c)),
      );
      setEditingCommentId(null);
      setEditDraft("");
    } catch (err) {
      notifyError(err, "Couldn't save the edit.");
    }
  }

  async function handleDeleteComment(id: string) {
    if (!item) return;
    try {
      const res = await fetch(`${basePath}/${item.id}/comments/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`Failed to delete comment (HTTP ${res.status})`);
      setComments((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      notifyError(err, "Couldn't delete the comment.");
    }
  }

  async function handleDuplicate(withChildren: boolean) {
    if (!item) return;
    setDupPrompt(false);
    setActionPending("duplicate");
    try {
      const res = await fetch(`${basePath}/${item.id}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ withChildren }),
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
  const canEditItem = can(Permission.ITEM_UPDATE);

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
          <div className="flex items-center justify-between gap-2 pr-10">
            <SheetTitle className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
              <span className="font-mono">#{item.ticketNumber}</span>
              {item.workItemType && (
                <span className="rounded px-1.5 py-0.5 font-medium bg-muted text-muted-foreground">
                  {item.workItemType.name}
                </span>
              )}
            </SheetTitle>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "gap-1.5",
                  watching ? "text-amber-500 hover:text-amber-500" : "text-muted-foreground",
                )}
                onClick={() => void toggleWatch()}
                disabled={watchPending}
                aria-pressed={watching}
                aria-label={watching ? "Unwatch this item" : "Watch this item"}
                title={watching ? "You're watching this item" : "Watch this item to track it"}
              >
                <Star className={cn("h-3.5 w-3.5", watching && "fill-current")} />
                {watching ? "Watching" : "Watch"}
              </Button>
                {canDuplicate && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-muted-foreground"
                    onClick={() =>
                      children.length > 0 ? setDupPrompt(true) : handleDuplicate(false)
                    }
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

          {/* Description — Write/Preview (Markdown) + `#` roadmap-node linking */}
          <RoadmapDescriptionField
            value={description}
            onChange={(v) => {
              setDescription(v);
              setDirty(true);
            }}
            orgId={orgId}
            projectId={projectId}
            resetKey={item.id}
          />

          {/* Source chip — if this item was created from a document (Files convert). */}
          <WorkItemDocumentSource itemId={item.id} orgId={orgId} projectId={projectId} />

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

            {/* SAFe epic classification (business vs enabler epic). Only epics
                carry it — hidden for features/stories/tasks. */}
            {(item?.workItemType?.key ?? "").split(".").pop()?.toLowerCase() ===
              "epic" && (
              <MetadataField icon={Wrench} label="Epic Type">
                <Select
                  items={{ BUSINESS: "Business", ENABLER: "Enabler" }}
                  value={workCategory}
                  onValueChange={(v) =>
                    handleFieldChange("workCategory", v as WorkItem["workCategory"])
                  }
                >
                  <SelectTrigger
                    size="sm"
                    aria-label="Epic Type"
                    className="w-full text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="BUSINESS">Business</SelectItem>
                    <SelectItem value="ENABLER">Enabler</SelectItem>
                  </SelectContent>
                </Select>
              </MetadataField>
            )}

            <MetadataField icon={User} label="Assignees">
              {/* Multi-assign (FR 1d38496a): checkbox list; first-checked stays
                  the primary. Falls back to "Unassigned" when the set is empty. */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="Assignees"
                  className="flex h-7 w-full items-center justify-between rounded-lg border border-input px-2 text-left text-xs transition-colors hover:bg-muted/40"
                >
                  <span className="truncate">
                    {assigneeIds.length === 0
                      ? "Unassigned"
                      : assigneeIds
                          .map(
                            (id) =>
                              members.find((m) => m.userId === id)?.user
                                ?.displayName ?? "Unknown",
                          )
                          .slice(0, 2)
                          .join(", ") +
                        (assigneeIds.length > 2
                          ? ` +${assigneeIds.length - 2}`
                          : "")}
                  </span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-72 min-w-52 overflow-y-auto">
                  {members.map((m) => (
                    <DropdownMenuCheckboxItem
                      key={m.userId}
                      checked={assigneeIds.includes(m.userId)}
                      onCheckedChange={(c) =>
                        void patchAssignees(
                          c
                            ? [...assigneeIds, m.userId]
                            : assigneeIds.filter((id) => id !== m.userId),
                        )
                      }
                    >
                      {m.user?.displayName ?? m.user?.email ?? "Unknown"}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
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

            <MetadataField icon={Calendar} label="Start date">
              <DatePicker
                value={startDate}
                onValueChange={(val) => {
                  setStartDate(val);
                  const isoVal = val
                    ? new Date(val + "T00:00:00Z").toISOString()
                    : null;
                  void patchField("startDate", isoVal);
                }}
                aria-label="Start date"
                className="h-7 text-xs"
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

          {/* Custom fields. Each def renders its typed editor; a change persists
              immediately via a merged customFields PUT. Type bindings already
              narrowed the list to fields that apply to this item's type. */}
          {itemCustomFields.length > 0 && (
            <>
              <Separator />
              <div className="grid grid-cols-2 gap-3">
                {itemCustomFields.map((f) => (
                  <CustomFieldInput
                    key={f.id}
                    field={f}
                    value={item.customFields?.[f.key]}
                    onChange={(v) => void patchCustomField(f.key, v)}
                    disabled={!canEditItem}
                    showRequiredMark
                  />
                ))}
              </div>
            </>
          )}

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
                {children.map((c, idx) => (
                  <div
                    key={c.id}
                    className={cn(
                      "group/child flex items-center gap-1.5 text-sm rounded transition-colors",
                      dragChildIdx !== null && dragChildIdx !== idx && "border-t border-transparent",
                    )}
                    onDragOver={(e) => {
                      if (dragChildIdx !== null) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragChildIdx !== null) void reorderChildren(dragChildIdx, idx);
                      setDragChildIdx(null);
                    }}
                  >
                    {canEditItem && children.length > 1 && (
                      <span
                        draggable
                        onDragStart={() => setDragChildIdx(idx)}
                        onDragEnd={() => setDragChildIdx(null)}
                        aria-label="Drag to reorder"
                        title="Drag to reorder"
                        className="shrink-0 cursor-grab text-muted-foreground/60 hover:text-muted-foreground active:cursor-grabbing"
                      >
                        <GripVertical className="h-3.5 w-3.5" />
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpenItem?.(c.id)}
                      disabled={!onOpenItem}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left enabled:hover:text-primary disabled:cursor-default"
                    >
                      <span className="font-mono text-[11px] text-muted-foreground shrink-0">
                        #{c.ticketNumber}
                      </span>
                      <span className="truncate">{c.title}</span>
                    </button>
                    {canEditItem && (
                      <button
                        type="button"
                        onClick={() => handleRemoveChild(c.id)}
                        aria-label="Remove sub-item"
                        title="Remove from sub-items (keeps the item)"
                        className="shrink-0 text-muted-foreground opacity-100 hover:text-destructive sm:opacity-0 sm:group-hover/child:opacity-100"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
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

          {/* Linked items / dependencies (blocks, relates-to, predecessor…). */}
          <WorkItemLinksSection
            orgId={orgId}
            projectId={projectId}
            itemId={item.id}
            canEdit={canEditItem}
            onOpenItem={onOpenItem}
          />

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
              {comments.map((c) => {
                const name =
                  c.authorName ?? c.author?.user?.displayName ?? "Unknown";
                const isEditing = editingCommentId === c.id;
                const edited =
                  !!c.updatedAt && c.updatedAt !== c.createdAt;
                return (
                  <div key={c.id} className="group/comment flex gap-2">
                    <Avatar size="sm">
                      <AvatarFallback>
                        {name.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium">{name}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(c.createdAt).toLocaleDateString()}
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
                        <div className="text-sm text-muted-foreground mt-0.5">
                          <MarkdownContent content={c.content} refMap={commentRefMap} />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {item && (
                <MentionedIn
                  orgId={orgId}
                  type="workItem"
                  id={item.id}
                  className="border-t pt-3"
                />
              )}

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
                {mentionState && (
                  <EntityMentionPicker
                    orgId={orgId}
                    query={mentionState.q}
                    anchor={mentionState.anchor}
                    onPick={pickEntity}
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
                        changed{" "}
                        <span className="font-medium">
                          {activityFieldLabel(a.field)}
                        </span>
                        {activityValueLabel(a.field, a.oldValue, activityResolvers) && (
                          <>
                            {" "}
                            from{" "}
                            <span className="line-through">
                              {activityValueLabel(a.field, a.oldValue, activityResolvers)}
                            </span>
                          </>
                        )}
                        {activityValueLabel(a.field, a.newValue, activityResolvers) && (
                          <>
                            {" "}
                            to{" "}
                            <span className="font-medium">
                              {activityValueLabel(a.field, a.newValue, activityResolvers)}
                            </span>
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

      {/* Duplicate-with-children prompt (only when the item has sub-items). */}
      <Dialog open={dupPrompt} onOpenChange={(o) => !o && setDupPrompt(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Duplicate sub-items too?</DialogTitle>
            <DialogDescription>
              #{item.ticketNumber} has {children.length} sub-item
              {children.length === 1 ? "" : "s"}. Copy {children.length === 1 ? "it" : "them"}{" "}
              under the new duplicate, or duplicate just this item?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-between">
            <Button
              variant="outline"
              onClick={() => handleDuplicate(false)}
              disabled={actionPending === "duplicate"}
            >
              Just this item
            </Button>
            <Button
              onClick={() => handleDuplicate(true)}
              disabled={actionPending === "duplicate"}
            >
              {actionPending === "duplicate"
                ? "Duplicating…"
                : `Include ${children.length} sub-item${children.length === 1 ? "" : "s"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

/** Default type for a new sub-item: one hierarchy level below its parent
 *  (epic→story, story→task, task/bug→subtask). Keys are sector-prefixed
 *  (e.g. "software.epic"), so match on the bare suffix. */
function childTypeFor(parentTypeKey: string | undefined): string {
  const bare = parentTypeKey?.split(".").pop()?.toUpperCase();
  switch (bare) {
    case "EPIC":
      return "STORY";
    case "STORY":
      return "TASK";
    case "TASK":
    case "BUG":
      return "SUBTASK";
    default:
      return "TASK";
  }
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
