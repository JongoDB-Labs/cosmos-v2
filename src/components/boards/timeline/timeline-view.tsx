"use client";

import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Route,
  Minimize2,
  Maximize2,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Loader2,
  GitCompareArrows,
  Wrench,
  Waypoints,
  Undo2,
  Redo2,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { notifyError } from "@/lib/errors/notify";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { cn } from "@/lib/utils";
import { buildTimelineTree } from "@/lib/boards/timeline-tree";
import { healthOf, slipDays } from "@/lib/schedule/health";
import type { WorkItem, OrgMember, Cycle, Board, BoardColumn, CustomField } from "@/types/models";
import {
  bareTypeKey,
  FilterBar,
  emptyFilters,
  matchesCustomFieldFilters,
  type BoardFilters,
} from "@/components/boards/shared/filter-bar";
import { useCustomFields } from "@/hooks/use-custom-fields";
import { CreateIssueButton } from "@/components/boards/shared/create-issue-button";
import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";

interface TimelineViewProps {
  orgId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
}

/** A work-item dependency link as returned by the work-item-links endpoint. */
interface WorkItemLink {
  id: string;
  type: string;
  sourceItemId: string;
  targetItemId: string;
  sourceTicketNumber: number;
  targetTicketNumber: number;
  createdAt: string;
}

const typeColorMap: Record<string, { fill: string; stroke: string; text: string }> = {
  EPIC: { fill: "#8b5cf6", stroke: "#7c3aed", text: "text-purple-200" },
  STORY: { fill: "#3b82f6", stroke: "#2563eb", text: "text-blue-200" },
  TASK: { fill: "#22c55e", stroke: "#16a34a", text: "text-green-200" },
  BUG: { fill: "#ef4444", stroke: "#dc2626", text: "text-red-200" },
  SUBTASK: { fill: "#6b7280", stroke: "#4b5563", text: "text-gray-200" },
};

const ROW_HEIGHT = 40;
const HEADER_HEIGHT = 50;
const DAY_WIDTH = 28;

// ── Collapse-state persistence (FR COSMOS-69) ───────────────────────────────
// The per-parent expand/collapse state is kept in sessionStorage, keyed by
// board id, so it survives navigating away from the timeline and back within
// the same browser session (and a reload) — not just interactions on the live
// view. sessionStorage (per-tab, cleared when the tab closes) matches the
// "within the timeline session" scope: it's remembered while you work, not
// forever. All access is guarded so private mode / disabled storage / SSR just
// degrade to the previous ephemeral behavior.
const collapseStorageKey = (boardId: string) => `cosmos:timeline-collapsed:${boardId}`;

function readCollapsedIds(boardId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.sessionStorage.getItem(collapseStorageKey(boardId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((x): x is string => typeof x === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeCollapsedIds(boardId: string, ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(collapseStorageKey(boardId), JSON.stringify([...ids]));
  } catch {
    /* private mode / disabled storage — collapse state stays ephemeral */
  }
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function diffDays(a: Date, b: Date): number {
  const msPerDay = 86400000;
  return Math.round((b.getTime() - a.getTime()) / msPerDay);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Schedule health for a bar — the ONE shared rule (@/lib/schedule/health),
 *  comparing the item's actual end (or "now" while open) against its current
 *  projected (due) date. Drives both the bar stroke and the actual-overlay
 *  color below. */
function barHealth(
  item: { dueDate: string | null; completedAt: string | null },
  now: Date,
): "green" | "red" | "neutral" {
  return healthOf({
    projectedEnd: item.dueDate ? startOfDay(new Date(item.dueDate)) : null,
    actualEnd: item.completedAt ? startOfDay(new Date(item.completedAt)) : null,
    now,
  });
}

/** The effective [start, end] a bar is drawn from — the SAME fallback the bar
 *  renderer uses (no startDate → createdAt; no dueDate → start + 7), so a drag
 *  computes against exactly what's on screen. */
function itemSpan(item: WorkItem): { start: Date; end: Date } {
  const start = item.startDate
    ? startOfDay(new Date(item.startDate))
    : startOfDay(new Date(item.createdAt));
  const end = item.dueDate ? startOfDay(new Date(item.dueDate)) : addDays(start, 7);
  return { start, end };
}

type DragMode = "move" | "start" | "end";

/** Client-side board-filter match (search/type/priority/assignee/cycle + custom
 *  fields) — mirrors the Kanban/Table logic so the Gantt's FilterBar behaves
 *  identically, including filtering by admin-defined custom fields. `defs` is the
 *  project's custom-field definitions (needed to interpret each active
 *  constraint's kind); an empty list makes the custom-field check inert. */
export function matchesFilters(
  item: WorkItem,
  f: BoardFilters,
  defs: CustomField[] = [],
): boolean {
  if (
    f.search &&
    !item.title.toLowerCase().includes(f.search.toLowerCase()) &&
    !String(item.ticketNumber).includes(f.search)
  )
    return false;
  if (f.types.length > 0 && !f.types.includes(bareTypeKey(item.workItemType?.key)))
    return false;
  if (f.priorities.length > 0 && !f.priorities.includes(item.priority)) return false;
  // Multi-assign: match the primary OR any member of the assignee set.
  if (
    f.assigneeId &&
    item.assigneeId !== f.assigneeId &&
    !item.assignees?.some((a) => a.userId === f.assigneeId)
  )
    return false;
  if (f.cycleId && item.cycleId !== f.cycleId) return false;
  if (!matchesCustomFieldFilters(item.customFields, f.customFields, defs)) return false;
  return true;
}

/** 0..1 completion for a bar's progress fill. A parent rolls up its children's
 *  done ratio; a leaf is complete (1) if it's completed or sits in a DONE column. */
function progressOf(item: WorkItem, doneKeys: Set<string>): number {
  const kids = item.children ?? [];
  if (kids.length > 0) {
    const done = kids.filter((k) => k.columnKey != null && doneKeys.has(k.columnKey)).length;
    return done / kids.length;
  }
  if (item.completedAt) return 1;
  return doneKeys.has(item.columnKey) ? 1 : 0;
}

/** A single Gantt analysis-lens toggle chip. Off = muted outline; on = tinted
 *  in the lens's accent color so several active lenses stay visually distinct. */
function LensToggle({
  active,
  onClick,
  icon,
  label,
  title,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  title: string;
  accent: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
        !active && "border-border hover:text-foreground",
      )}
      style={
        active
          ? { borderColor: accent, color: accent, backgroundColor: `color-mix(in srgb, ${accent} 12%, transparent)` }
          : undefined
      }
      data-active={active}
    >
      <span
        className={cn(
          "inline-flex items-center gap-1.5",
          !active && "text-muted-foreground",
        )}
      >
        {icon} {label}
      </span>
    </button>
  );
}

export function TimelineView({ orgId, projectId, projectKey, boardId }: TimelineViewProps) {
  const [hoveredItem, setHoveredItem] = useState<WorkItem | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  const qc = useQueryClient();
  const itemsKey = useOrgQueryKey("work-items", projectId);
  const membersKey = useOrgQueryKey("members");
  const linksKey = useOrgQueryKey("work-item-links", projectId);
  const boardKey = useOrgQueryKey("board", boardId);
  const cyclesKey = useOrgQueryKey("cycles", projectId);

  const [itemsQ, membersQ, linksQ, boardQ, cyclesQ] = useQueries({
    queries: [
      {
        queryKey: itemsKey,
        queryFn: () => jsonFetch<WorkItem[]>(`${basePath}/work-items`),
      },
      {
        queryKey: membersKey,
        queryFn: () => jsonFetch<OrgMember[]>(`/api/v1/orgs/${orgId}/members`),
      },
      {
        // Dependency links (prod-parity): drives the Gantt dependency arrows.
        queryKey: linksKey,
        queryFn: () => jsonFetch<WorkItemLink[]>(`${basePath}/work-item-links`),
      },
      {
        // Board (for its columns) + cycles — needed so a bar click can open the
        // SAME CardDetailSheet the Kanban/Table views use (FR: card detail
        // reachable + editable from the Timeline too).
        queryKey: boardKey,
        queryFn: () => jsonFetch<Board>(`${basePath}/boards/${boardId}`),
      },
      {
        queryKey: cyclesKey,
        queryFn: () => jsonFetch<Cycle[]>(`${basePath}/cycles`),
      },
    ],
  });

  const items = useMemo<WorkItem[]>(() => itemsQ.data ?? [], [itemsQ.data]);
  // Distinct bare type keys present on this board — scopes the Type filter to
  // what's actually here (see FilterBar.presentTypeKeys).
  const presentTypeKeys = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) {
      if (it.workItemType?.key) s.add(bareTypeKey(it.workItemType.key));
    }
    return [...s];
  }, [items]);
  const members = useMemo<OrgMember[]>(() => membersQ.data ?? [], [membersQ.data]);
  const links = useMemo<WorkItemLink[]>(() => linksQ.data ?? [], [linksQ.data]);
  const columns = useMemo<BoardColumn[]>(() => boardQ.data?.columns ?? [], [boardQ.data]);
  const cycles = useMemo<Cycle[]>(() => cyclesQ.data ?? [], [cyclesQ.data]);
  // Custom-field defs for this project (org-wide + project-scoped) — drives the
  // FilterBar's per-field controls and the client-side filter match below, so a
  // defined field is filterable on the Gantt exactly as it is on the Kanban board.
  const { fields: projectCustomFields } = useCustomFields(orgId, projectId);

  // ── Gantt controls ───────────────────────────────────────────────────────
  // FilterBar filters (search/type/priority/assignee/cycle), a critical-path
  // highlight toggle, and a busy flag while a bulk shift/compress is in flight.
  const [filters, setFilters] = useState<BoardFilters>(emptyFilters);
  // Analysis "lenses" (FR gantt-enh) — a small set of overlay toggles the user
  // flips to read the schedule a particular way, replacing the lone Critical
  // path button: critical chain, planned-vs-actual baselines, enabler emphasis.
  const [showCritical, setShowCritical] = useState(false);
  const [showPlanDrift, setShowPlanDrift] = useState(false);
  const [showEnablers, setShowEnablers] = useState(false);
  const [showDeps, setShowDeps] = useState(false);
  const [busy, setBusy] = useState(false);

  const filteredItems = useMemo(
    () => items.filter((it) => matchesFilters(it, filters, projectCustomFields)),
    [items, filters, projectCustomFields],
  );
  const hasEnablers = useMemo(
    () => filteredItems.some((it) => it.workCategory === "ENABLER"),
    [filteredItems],
  );

  // ── Hierarchy rows (FR f396a6a9) ─────────────────────────────────────────
  // Depth-first parent→children row order with per-parent collapse. Collapsing a
  // parent hides its whole subtree (rows, bars, and arrows all key off the row
  // list). A child whose parent is filtered out surfaces as a root so a filter
  // can never hide items silently. Ordering (roots by start date, sub-items by
  // their manual sortOrder — FR COSMOS-5) lives in `buildTimelineTree`.
  //
  // The collapse state is seeded from (and written back to) sessionStorage keyed
  // by board, so it persists across navigating away and back within the session
  // (FR COSMOS-69) rather than resetting every time the view mounts.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() =>
    readCollapsedIds(boardId),
  );
  // If this same view instance is reused for a different board (TIMELINE →
  // TIMELINE navigation reconciles rather than remounts), re-seed that board's
  // saved state instead of carrying the previous board's collapse set over.
  const boardRef = useRef(boardId);
  useEffect(() => {
    if (boardRef.current === boardId) return;
    boardRef.current = boardId;
    setCollapsedIds(readCollapsedIds(boardId));
  }, [boardId]);

  const fullTree = useMemo(
    () => buildTimelineTree(filteredItems, collapsedIds),
    [filteredItems, collapsedIds],
  );

  // When the Dependencies lens is on, focus on the interdependent set.
  const linkedIds = useMemo(() => {
    const set = new Set<string>();
    for (const l of links) {
      set.add(l.sourceItemId);
      set.add(l.targetItemId);
    }
    return set;
  }, [links]);

  // Dependencies view: keep the SAME epic/feature/story nesting as the normal
  // view, just restricted to the linked set. Include every linked item AND its
  // ancestor chain (ancestors are shown for structure even when not themselves
  // linked), then build the identical depth-first tree so nesting and collapse
  // behave exactly as when the lens is off — no more flat, depth-0 list.
  const depsTree = useMemo(() => {
    if (!showDeps) return { treeRows: [], parentIds: new Set<string>() };
    const byId = new Map(filteredItems.map((i) => [i.id, i]));
    const keep = new Set<string>();
    for (const it of filteredItems) {
      if (!linkedIds.has(it.id)) continue;
      keep.add(it.id);
      let pid = it.parentId;
      while (pid && byId.has(pid) && !keep.has(pid)) {
        keep.add(pid);
        pid = byId.get(pid)!.parentId;
      }
    }
    return buildTimelineTree(
      filteredItems.filter((it) => keep.has(it.id)),
      collapsedIds,
    );
  }, [showDeps, filteredItems, linkedIds, collapsedIds]);

  const { treeRows, parentIds } = showDeps ? depsTree : fullTree;
  const visibleRows = treeRows;

  // Apply a change to the collapse set and persist it in one step, so the
  // session-restored state always matches what's on screen.
  const commitCollapsed = useCallback(
    (next: Set<string>) => {
      writeCollapsedIds(boardId, next);
      setCollapsedIds(next);
    },
    [boardId],
  );

  const toggleCollapse = useCallback(
    (id: string) => {
      const next = new Set(collapsedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      commitCollapsed(next);
    },
    [collapsedIds, commitCollapsed],
  );
  const doneKeys = useMemo(
    () => new Set(columns.filter((c) => c.category === "DONE").map((c) => c.key)),
    [columns],
  );

  // Click a bar → open the shared work-item detail (same as other board views).
  // Tracked by id + derived from the live items so edits/deletes stay in sync.
  const [detailId, setDetailId] = useState<string | null>(null);

  // Resizable Work Items column (persisted) — drag the handle on its right edge.
  const [nameColW, setNameColW] = useState<number>(() => {
    if (typeof window === "undefined") return 260;
    const n = Number(window.localStorage.getItem("gantt-name-col-w"));
    return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 160), 640) : 260;
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("gantt-name-col-w", String(nameColW));
    } catch {
      /* ignore quota / private mode */
    }
  }, [nameColW]);
  const nameResizeRef = useRef<{ startX: number; startW: number } | null>(null);
  const onNameResizeDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      nameResizeRef.current = { startX: e.clientX, startW: nameColW };
    },
    [nameColW],
  );
  const onNameResizeMove = useCallback((e: React.PointerEvent) => {
    const d = nameResizeRef.current;
    if (!d) return;
    setNameColW(Math.min(Math.max(d.startW + (e.clientX - d.startX), 160), 640));
  }, []);
  const onNameResizeUp = useCallback(() => {
    nameResizeRef.current = null;
  }, []);
  const detailItem = detailId
    ? items.find((i) => i.id === detailId) ?? null
    : null;
  // A real drag (movement) also fires a trailing click — suppress it so a
  // reschedule/resize doesn't pop the detail sheet.
  const justDraggedRef = useRef(false);

  // Undo/redo for drag reschedules (the Gantt's mutating action). Each edit stores
  // the item's full before/after date range so undo/redo just re-commits a snapshot.
  type ScheduleEdit = {
    id: string;
    before: { startDate: string; dueDate: string };
    after: { startDate: string; dueDate: string };
  };
  const [undoStack, setUndoStack] = useState<ScheduleEdit[]>([]);
  const [redoStack, setRedoStack] = useState<ScheduleEdit[]>([]);
  const loading = itemsQ.isLoading || membersQ.isLoading;
  const error = itemsQ.error
    ? itemsQ.error instanceof Error
      ? itemsQ.error.message
      : "Unknown error"
    : null;

  const memberMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      map.set(m.userId, m.user?.displayName ?? m.user?.email ?? "Unknown");
    }
    return map;
  }, [members]);

  // Compute timeline range. The range spans ALL filtered items (collapsed
  // subtrees included) so collapsing never reflows the axis; row ORDER comes
  // from the hierarchy walk above.
  const { timelineStart, totalDays } = useMemo(() => {
    if (filteredItems.length === 0) {
      const now = startOfDay(new Date());
      return { timelineStart: addDays(now, -7), totalDays: 37 };
    }

    let minDate = new Date();
    let maxDate = new Date();

    for (const item of filteredItems) {
      const start = item.startDate ? new Date(item.startDate) : new Date(item.createdAt);
      const end = item.dueDate ? new Date(item.dueDate) : addDays(start, 7);

      if (start < minDate) minDate = start;
      if (end > maxDate) maxDate = end;
    }

    // Add padding
    const padStart = addDays(startOfDay(minDate), -3);
    const padEnd = addDays(startOfDay(maxDate), 7);
    const days = Math.max(diffDays(padStart, padEnd), 30);

    return { timelineStart: padStart, totalDays: days };
  }, [filteredItems]);

  const sortedItems = useMemo(() => visibleRows.map((r) => r.item), [visibleRows]);

  // Generate date headers
  const dateHeaders = useMemo(() => {
    const headers: Array<{ date: Date; label: string; isMonthStart: boolean; isWeekStart: boolean }> = [];
    for (let i = 0; i < totalDays; i++) {
      const d = addDays(timelineStart, i);
      headers.push({
        date: d,
        label: String(d.getDate()),
        isMonthStart: d.getDate() === 1,
        isWeekStart: d.getDay() === 1,
      });
    }
    return headers;
  }, [timelineStart, totalDays]);

  // Month labels
  const monthLabels = useMemo(() => {
    const labels: Array<{ month: string; startX: number; width: number }> = [];
    let currentMonth = "";
    let startIdx = 0;

    for (let i = 0; i < dateHeaders.length; i++) {
      const d = dateHeaders[i].date;
      const monthKey = `${d.getFullYear()}-${d.getMonth()}`;
      if (monthKey !== currentMonth) {
        if (currentMonth !== "") {
          labels.push({
            month: new Date(
              dateHeaders[startIdx].date
            ).toLocaleString("default", { month: "short", year: "numeric" }),
            startX: startIdx * DAY_WIDTH,
            width: (i - startIdx) * DAY_WIDTH,
          });
        }
        currentMonth = monthKey;
        startIdx = i;
      }
    }
    // Push last month
    if (currentMonth !== "") {
      labels.push({
        month: new Date(
          dateHeaders[startIdx].date
        ).toLocaleString("default", { month: "short", year: "numeric" }),
        startX: startIdx * DAY_WIDTH,
        width: (dateHeaders.length - startIdx) * DAY_WIDTH,
      });
    }

    return labels;
  }, [dateHeaders]);

  // Bar geometry per item id — the SAME formulas the bar renderer below uses,
  // so the dependency-arrow layer can resolve each end's bar position. Keyed by
  // item id; only items with a visible row appear.
  const barPositions = useMemo(() => {
    const map = new Map<string, { x: number; y: number; w: number; h: number }>();
    const nowDay = startOfDay(new Date());
    sortedItems.forEach((item, i) => {
      // Anchor arrows to the SOLID (primary) bar: the ACTUAL span when it exists
      // (what's drawn solid), else the planned span — never the faded planned trail
      // ("phantom"). Hover/detail are unaffected.
      const aStart = item.actualStart ? startOfDay(new Date(item.actualStart)) : null;
      const start = aStart
        ? aStart
        : item.startDate
          ? startOfDay(new Date(item.startDate))
          : startOfDay(new Date(item.createdAt));
      const end = aStart
        ? item.completedAt
          ? startOfDay(new Date(item.completedAt))
          : nowDay
        : item.dueDate
          ? startOfDay(new Date(item.dueDate))
          : addDays(start, 7);
      const startOffset = diffDays(timelineStart, start);
      const duration = Math.max(diffDays(start, end), 1);
      map.set(item.id, {
        x: startOffset * DAY_WIDTH,
        // Body-SVG coordinates: the date header lives in its own sticky SVG, so
        // rows start at y=0 here.
        y: i * ROW_HEIGHT + 8,
        w: Math.max(duration * DAY_WIDTH, DAY_WIDTH),
        h: ROW_HEIGHT - 16,
      });
    });
    return map;
  }, [sortedItems, timelineStart]);

  // ── Drag-to-reschedule ───────────────────────────────────────────────────
  // Drag a bar's body to shift both dates; drag its left/right edge to move just
  // the start/due. Day-snapped. Gated on ITEM_UPDATE (bars stay read-only
  // otherwise). Optimistic cache write, then PUT; on error we re-fetch to revert.
  const { can } = usePermissions();
  const canEdit = can(Permission.ITEM_UPDATE);
  const dragRef = useRef<{
    id: string;
    mode: DragMode;
    startClientX: number;
    origStart: Date;
    origEnd: Date;
    captured: boolean;
  } | null>(null);
  const [dragPreview, setDragPreview] = useState<{
    id: string;
    mode: DragMode;
    deltaDays: number;
  } | null>(null);

  const beginDrag = useCallback(
    (item: WorkItem, mode: DragMode, e: React.PointerEvent) => {
      if (!canEdit) return;
      e.preventDefault();
      e.stopPropagation();
      const { start, end } = itemSpan(item);
      dragRef.current = {
        id: item.id,
        mode,
        startClientX: e.clientX,
        origStart: start,
        origEnd: end,
        captured: false,
      };
      setDragPreview({ id: item.id, mode, deltaDays: 0 });
      setHoveredItem(null);
    },
    [canEdit],
  );

  const onDragMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // Capture the pointer only once a real drag starts (>3px) — NEVER on a tap.
    // A tap that opens the detail sheet must not hold pointer capture, or the
    // sheet's controls (e.g. the status Select) won't get their clicks — the
    // Gantt-only "status dropdown won't open" bug.
    if (!d.captured && Math.abs(e.clientX - d.startClientX) > 3) {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      d.captured = true;
    }
    const deltaDays = Math.round((e.clientX - d.startClientX) / DAY_WIDTH);
    setDragPreview((p) =>
      p && p.deltaDays === deltaDays ? p : { id: d.id, mode: d.mode, deltaDays },
    );
  }, []);

  // The browser/OS can fire pointercancel mid-drag (touch scroll-takeover,
  // incoming call, palm rejection) — and then NO pointerup follows. Without
  // this the bar would stay stuck at its preview offset and tooltips would stay
  // suppressed (both guard on dragRef) until the next pointerdown. Cancel = drop
  // the gesture with no commit.
  const onDragCancel = useCallback(() => {
    dragRef.current = null;
    setDragPreview(null);
  }, []);

  // Open the shared detail sheet on a click/right-click — unless the gesture was
  // a drag (which fires a trailing click we must ignore).
  const openDetail = useCallback((item: WorkItem) => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    setDetailId(item.id);
  }, []);

  // Persist a date snapshot (optimistic cache write + PUT). Shared by drag commit
  // and undo/redo so they behave identically.
  const commitDates = useCallback(
    (id: string, body: { startDate: string; dueDate: string }) => {
      qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
        prev?.map((it) => (it.id === id ? { ...it, ...body } : it)),
      );
      void (async () => {
        try {
          await jsonFetch(`${basePath}/work-items/${id}`, {
            method: "PUT",
            body: JSON.stringify(body),
          });
          toast.success("Schedule updated");
          qc.invalidateQueries({ queryKey: itemsKey });
        } catch (err) {
          notifyError(err, "Couldn't reschedule the item.");
          qc.invalidateQueries({ queryKey: itemsKey });
        }
      })();
    },
    [qc, itemsKey, basePath],
  );

  const onDragEnd = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      const deltaDays = Math.round((e.clientX - d.startClientX) / DAY_WIDTH);
      setDragPreview(null);
      if (deltaDays === 0) return; // a tap, not a drag — let onClick open detail
      justDraggedRef.current = true; // suppress the trailing click after a drag

      let newStart = d.origStart;
      let newEnd = d.origEnd;
      if (d.mode === "move") {
        newStart = addDays(d.origStart, deltaDays);
        newEnd = addDays(d.origEnd, deltaDays);
      } else if (d.mode === "start") {
        newStart = addDays(d.origStart, deltaDays);
        // Can't reach/cross the due date — clamp to a 1-day bar ending at it,
        // matching what the live preview shows (right edge pinned, min width).
        if (newStart >= newEnd) newStart = addDays(newEnd, -1);
      } else {
        newEnd = addDays(d.origEnd, deltaDays);
        if (newEnd < newStart) newEnd = newStart; // can't precede the start
      }

      const before = {
        startDate: d.origStart.toISOString(),
        dueDate: d.origEnd.toISOString(),
      };
      const after = {
        startDate: newStart.toISOString(),
        dueDate: newEnd.toISOString(),
      };
      setUndoStack((prev) => [...prev, { id: d.id, before, after }]);
      setRedoStack([]);
      commitDates(d.id, after);
    },
    [commitDates],
  );

  const undo = useCallback(() => {
    if (undoStack.length === 0) return;
    const op = undoStack[undoStack.length - 1];
    commitDates(op.id, op.before);
    setUndoStack((s) => s.slice(0, -1));
    setRedoStack((r) => [...r, op]);
  }, [undoStack, commitDates]);
  const redo = useCallback(() => {
    if (redoStack.length === 0) return;
    const op = redoStack[redoStack.length - 1];
    commitDates(op.id, op.after);
    setRedoStack((s) => s.slice(0, -1));
    setUndoStack((u) => [...u, op]);
  }, [redoStack, commitDates]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))
        return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // ── Critical path ────────────────────────────────────────────────────────
  // The longest dependency chain (by summed bar duration) through the currently
  // visible items. DP over the dependency DAG (cycle-guarded); highlighted only
  // when toggled on.
  const criticalSet = useMemo(() => {
    if (!showCritical) return new Set<string>();
    const ids = new Set(filteredItems.map((i) => i.id));
    const dur = new Map<string, number>();
    for (const it of filteredItems) {
      const { start, end } = itemSpan(it);
      dur.set(it.id, Math.max(diffDays(start, end), 1));
    }
    const preds = new Map<string, string[]>();
    for (const l of links) {
      if (ids.has(l.sourceItemId) && ids.has(l.targetItemId)) {
        const arr = preds.get(l.targetItemId) ?? [];
        arr.push(l.sourceItemId);
        preds.set(l.targetItemId, arr);
      }
    }
    const memo = new Map<string, number>();
    const best = new Map<string, string | null>();
    const visiting = new Set<string>();
    const dp = (id: string): number => {
      const cached = memo.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) return dur.get(id) ?? 1; // cycle guard
      visiting.add(id);
      let bestVal = 0;
      let bestPred: string | null = null;
      for (const p of preds.get(id) ?? []) {
        const v = dp(p);
        if (v > bestVal) {
          bestVal = v;
          bestPred = p;
        }
      }
      visiting.delete(id);
      const total = (dur.get(id) ?? 1) + bestVal;
      memo.set(id, total);
      best.set(id, bestPred);
      return total;
    };
    let endId: string | null = null;
    let max = -1;
    for (const it of filteredItems) {
      const v = dp(it.id);
      if (v > max) {
        max = v;
        endId = it.id;
      }
    }
    const set = new Set<string>();
    let cur: string | null = endId;
    while (cur) {
      set.add(cur);
      cur = best.get(cur) ?? null;
    }
    return set;
  }, [showCritical, filteredItems, links]);

  // Dependency focus: when the Dependencies lens is on and a bar is hovered,
  // resolve its DIRECT upstream (blockers) + downstream (dependents) so the
  // render can light that neighborhood and fade everything else (anti-spaghetti).
  const depFocus = useMemo(() => {
    if (!showDeps || !hoveredItem) return null;
    const up = new Set<string>();
    const down = new Set<string>();
    for (const l of links) {
      if (l.targetItemId === hoveredItem.id) up.add(l.sourceItemId);
      if (l.sourceItemId === hoveredItem.id) down.add(l.targetItemId);
    }
    return { id: hoveredItem.id, up, down, all: new Set<string>([hoveredItem.id, ...up, ...down]) };
  }, [showDeps, hoveredItem, links]);

  // ── Bulk schedule ops ────────────────────────────────────────────────────
  // The "adjust schedules / time compression in real-time" workspace: shift
  // moves every VISIBLE item by N days; compress/expand scales each item's
  // offset-from-start AND its duration by a factor, pivoting on the timeline
  // start. Optimistic cache write, then PUT each; refetch on any failure.
  const bulkReschedule = useCallback(
    async (compute: (span: { start: Date; end: Date }) => { start: Date; end: Date }) => {
      if (!canEdit || busy || filteredItems.length === 0) return;
      setBusy(true);
      const updates = filteredItems.map((it) => {
        const next = compute(itemSpan(it));
        return {
          id: it.id,
          startDate: next.start.toISOString(),
          dueDate: next.end.toISOString(),
        };
      });
      qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
        prev?.map((it) => {
          const u = updates.find((x) => x.id === it.id);
          return u ? { ...it, startDate: u.startDate, dueDate: u.dueDate } : it;
        }),
      );
      const results = await Promise.allSettled(
        updates.map((u) =>
          jsonFetch(`${basePath}/work-items/${u.id}`, {
            method: "PUT",
            body: JSON.stringify({ startDate: u.startDate, dueDate: u.dueDate }),
          }),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        notifyError(
          new Error("Some items couldn't be rescheduled"),
          `${failed} of ${updates.length} failed`,
        );
      } else {
        toast.success(`Rescheduled ${updates.length} item${updates.length === 1 ? "" : "s"}`);
      }
      qc.invalidateQueries({ queryKey: itemsKey });
      setBusy(false);
    },
    [canEdit, busy, filteredItems, qc, itemsKey, basePath],
  );

  const shiftDays = (days: number) =>
    void bulkReschedule(({ start, end }) => ({
      start: addDays(start, days),
      end: addDays(end, days),
    }));

  const scaleBy = (factor: number) =>
    void bulkReschedule(({ start, end }) => {
      const offset = diffDays(timelineStart, start);
      const dur = Math.max(diffDays(start, end), 1);
      const newStart = addDays(timelineStart, Math.round(offset * factor));
      const newEnd = addDays(newStart, Math.max(Math.round(dur * factor), 1));
      return { start: newStart, end: newEnd };
    });

  const today = startOfDay(new Date());
  const todayOffset = diffDays(timelineStart, today);

  const svgWidth = totalDays * DAY_WIDTH;
  // The date header renders in its own sticky SVG; the body SVG holds only rows.
  const bodyHeight = sortedItems.length * ROW_HEIGHT + 20;

  if (loading) return <TimelineSkeleton />;

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-sm text-destructive mb-2">Failed to load board</p>
          <p className="text-xs text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  // Only short-circuit when the board is TRULY empty. If items exist but the
  // active filters match none, fall through so the FilterBar still renders (the
  // user needs it to clear the filter) over an empty chart.
  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm text-muted-foreground">
          No work items to display on timeline. Items need start or due dates.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <FilterBar
        filters={filters}
        onFilterChange={setFilters}
        members={members}
        cycles={cycles}
        orgId={orgId}
        customFields={projectCustomFields}
        presentTypeKeys={presentTypeKeys}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Analysis lenses — overlay toggles that recolor/annotate the chart
              rather than change data. Grouped under one label so the toolbar
              reads as "ways to look at the schedule," not scattered buttons. */}
          <span className="text-xs font-medium text-muted-foreground">Lenses</span>
          <LensToggle
            active={showCritical}
            onClick={() => setShowCritical((v) => !v)}
            icon={<Route className="size-3.5" />}
            label="Critical path"
            title="Highlight the longest chain of dependencies driving the end date"
            accent="var(--status-critical)"
          />
          <LensToggle
            active={showPlanDrift}
            onClick={() => setShowPlanDrift((v) => !v)}
            icon={<GitCompareArrows className="size-3.5" />}
            label="Plan drift"
            title="Overlay the original planned dates (faded ghost) on the actual bars to see how the plan shifted"
            accent="var(--status-blocked)"
          />
          <LensToggle
            active={showEnablers}
            onClick={() => setShowEnablers((v) => !v)}
            icon={<Wrench className="size-3.5" />}
            label="Enablers"
            title="Emphasize enabler work (architecture, infra, compliance) vs. business value"
            accent="var(--type-enabler, #0891b2)"
          />
          <LensToggle
            active={showDeps}
            onClick={() => {
              setShowDeps((v) => !v);
              void qc.invalidateQueries({ queryKey: linksKey });
            }}
            icon={<Waypoints className="size-3.5" />}
            label="Dependencies"
            title="Show links between items; hover a bar to trace its upstream (amber) and downstream (blue) dependencies — everything else fades"
            accent="#0ea5e9"
          />
          <div className="mx-1 h-5 w-px bg-border" />
          {parentIds.size > 0 && (
            <button
              onClick={() =>
                commitCollapsed(collapsedIds.size > 0 ? new Set() : new Set(parentIds))
              }
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              title={
                collapsedIds.size > 0
                  ? "Expand every parent item"
                  : "Collapse every parent item to a single row"
              }
            >
              {collapsedIds.size > 0 ? (
                <>
                  <ChevronsUpDown className="size-3.5" /> Expand all
                </>
              ) : (
                <>
                  <ChevronsDownUp className="size-3.5" /> Collapse all
                </>
              )}
            </button>
          )}
          {canEdit && (
            <>
              <div className="mx-1 h-5 w-px bg-border" />
              <span className="text-xs text-muted-foreground">Shift</span>
              {[-7, -1, 1, 7].map((d) => (
                <Button
                  key={d}
                  variant="outline"
                  size="xs"
                  disabled={busy}
                  onClick={() => shiftDays(d)}
                  title={`Shift all visible items ${d > 0 ? "+" : ""}${d} day${Math.abs(d) === 1 ? "" : "s"}`}
                >
                  {d < 0 ? <ChevronLeft className="size-3" /> : null}
                  {d > 0 ? "+" : ""}
                  {d}d
                  {d > 0 ? <ChevronRight className="size-3" /> : null}
                </Button>
              ))}
              <div className="mx-1 h-5 w-px bg-border" />
              <span className="text-xs text-muted-foreground">Scale</span>
              <Button
                variant="outline"
                size="xs"
                disabled={busy}
                onClick={() => scaleBy(0.9)}
                title="Compress the schedule 10% (pull dates toward the start)"
              >
                <Minimize2 className="size-3" /> Compress
              </Button>
              <Button
                variant="outline"
                size="xs"
                disabled={busy}
                onClick={() => scaleBy(1.1)}
                title="Expand the schedule 10% (push dates out from the start)"
              >
                <Maximize2 className="size-3" /> Expand
              </Button>
              <div className="mx-1 h-5 w-px bg-border" />
              <Button
                variant="outline"
                size="xs"
                disabled={undoStack.length === 0}
                onClick={undo}
                title="Undo reschedule (⌘/Ctrl-Z)"
              >
                <Undo2 className="size-3" /> Undo
              </Button>
              <Button
                variant="outline"
                size="xs"
                disabled={redoStack.length === 0}
                onClick={redo}
                title="Redo reschedule (⌘/Ctrl-Y)"
              >
                <Redo2 className="size-3" /> Redo
              </Button>
              {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canEdit && (
            <p className="hidden text-xs text-muted-foreground lg:block">
              Drag a bar to reschedule · drag edges to resize
            </p>
          )}
          <CreateIssueButton
            orgId={orgId}
            projectId={projectId}
            boardId={boardId}
            onCreated={() => qc.invalidateQueries({ queryKey: itemsKey })}
          />
        </div>
      </div>
      {/* Contextual legend — only the keys for what's actually on screen. */}
      {(showPlanDrift || hasEnablers) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b bg-[var(--surface)] px-4 py-1.5 text-[11px] text-muted-foreground">
          {showPlanDrift && (
            <>
              <span className="text-[var(--text-muted)]">Plan ghost:</span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2 rounded-sm"
                  style={{ backgroundColor: "var(--status-done)", opacity: 0.5 }}
                />
                On/ahead
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2 rounded-sm"
                  style={{ backgroundColor: "var(--status-critical)", opacity: 0.5 }}
                />
                Slipped
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2 rounded-sm"
                  style={{ backgroundColor: "#f59e0b", opacity: 0.5 }}
                />
                Started late
              </span>
            </>
          )}
          {hasEnablers && (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-5 rounded-sm bg-muted-foreground/30"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(45deg, rgba(255,255,255,0.6) 0 2px, transparent 2px 5px)",
                }}
              />
              Enabler work
            </span>
          )}
        </div>
      )}
      {/* ONE scroll container holds both the item labels and the chart, so
          vertical scroll is structurally locked: every label shares the same
          scroll flow as its bar. (The old design gave each pane its own scroller
          and mirrored scrollTop in JS — but the chart pane is taller and its
          viewport is shortened by the horizontal scrollbar, so it could scroll
          while the label pane had nothing to scroll: the tickets "didn't move.")
          The label column pins with `sticky left-0` during horizontal scroll;
          both headers pin with `sticky top-0`.

          `items-start` is REQUIRED for those `sticky top-0` headers to work
          (COSMOS-68). This is a flex row; with the default `align-items:
          stretch` each pane is stretched to the scroller's VIEWPORT height, which
          collapses the sticky containing block — the date/label headers then only
          pin for the first viewport-height of scroll and slide off after that
          (browser-verified). `items-start` sizes each pane to its own content, so
          the headers stay pinned the whole way down. */}
      <div
        data-testid="gantt-scroll"
        className="relative flex flex-1 items-start overflow-auto"
      >
        {/* Left column - item labels. Narrower on phones so the chart isn't
            crowded off-screen; the SVG rows align by height, not this width. */}
        <div
          data-testid="gantt-left"
          className="sticky left-0 z-20 shrink-0 border-r bg-background"
          style={{ width: nameColW }}
        >
          <div
            className="sticky top-0 z-10 border-b bg-[var(--surface)] flex items-center px-3 text-xs font-medium text-muted-foreground"
            style={{ height: HEADER_HEIGHT }}
          >
            Work Items
          </div>
          {visibleRows.map(({ item, depth }) => {
            const colors = typeColorMap[bareTypeKey(item.workItemType?.key)] ?? typeColorMap.TASK;
            const isParent = parentIds.has(item.id);
            const isCollapsed = collapsedIds.has(item.id);
            return (
              <div
                key={item.id}
                className="flex w-full items-center border-b border-border/30 hover:bg-muted/30 transition-colors"
                style={{ height: ROW_HEIGHT, paddingLeft: 6 + depth * 14 }}
              >
                {isParent ? (
                  <button
                    type="button"
                    onClick={() => toggleCollapse(item.id)}
                    aria-label={isCollapsed ? "Expand children" : "Collapse children"}
                    aria-expanded={!isCollapsed}
                    className="mr-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <ChevronRight
                      className={cn("size-3.5 transition-transform", !isCollapsed && "rotate-90")}
                    />
                  </button>
                ) : (
                  <span className="w-[22px] shrink-0" />
                )}
                <button
                  type="button"
                  onClick={() => setDetailId(item.id)}
                  title={`${projectKey}-${item.ticketNumber}: ${item.title}`}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 pr-3 text-left"
                >
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: colors.fill }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs truncate">
                      <span className="text-muted-foreground mr-1">
                        {projectKey}-{item.ticketNumber}
                      </span>
                      {item.title}
                    </p>
                  </div>
                </button>
              </div>
            );
          })}
          {/* Drag handle — resize the Work Items column (persisted). */}
          <div
            onPointerDown={onNameResizeDown}
            onPointerMove={onNameResizeMove}
            onPointerUp={onNameResizeUp}
            onPointerCancel={onNameResizeUp}
            className="absolute right-0 top-0 bottom-0 z-30 w-1.5 translate-x-1/2 cursor-col-resize hover:bg-[var(--primary)]/40"
            style={{ touchAction: "none" }}
            title="Drag to resize the Work Items column"
          />
        </div>

        {/* Right column - the chart. Sized to its full content; the shared outer
            container does the scrolling for both panes. */}
        <div data-testid="gantt-chart" className="shrink-0" style={{ width: svgWidth }}>
            {/* Sticky date header (FR e4d1732e / COSMOS-68): pinned to the outer
                scroller while scrolling down (needs `items-start` on the scroller
                — see the scroll container above), but scrolls horizontally with
                the chart because it sits inside the svgWidth chart column —
                `sticky top-0` only pins the vertical axis. */}
            <div
              data-testid="gantt-date-header"
              className="sticky top-0 z-10 border-b border-border bg-[var(--surface)]"
              style={{ height: HEADER_HEIGHT }}
            >
              <svg width={svgWidth} height={HEADER_HEIGHT} className="block">
                {monthLabels.map((m, i) => (
                  <g key={i}>
                    <rect
                      x={m.startX}
                      y={0}
                      width={m.width}
                      height={24}
                      className="fill-muted/50"
                    />
                    <text
                      x={m.startX + m.width / 2}
                      y={16}
                      textAnchor="middle"
                      className="fill-muted-foreground text-[10px]"
                      style={{ fontSize: 10 }}
                    >
                      {m.month}
                    </text>
                  </g>
                ))}
                {dateHeaders.map((h, i) => {
                  const x = i * DAY_WIDTH;
                  const isWeekend = h.date.getDay() === 0 || h.date.getDay() === 6;
                  return (
                    <g key={i}>
                      {isWeekend && (
                        <rect
                          x={x}
                          y={24}
                          width={DAY_WIDTH}
                          height={HEADER_HEIGHT - 24}
                          className="fill-muted/20"
                        />
                      )}
                      <text
                        x={x + DAY_WIDTH / 2}
                        y={40}
                        textAnchor="middle"
                        className="fill-muted-foreground text-[9px]"
                        style={{ fontSize: 9 }}
                      >
                        {h.label}
                      </text>
                    </g>
                  );
                })}
                {/* Today dot — the dashed line itself lives in the body SVG. */}
                {todayOffset >= 0 && todayOffset < totalDays && (
                  <circle
                    cx={todayOffset * DAY_WIDTH + DAY_WIDTH / 2}
                    cy={HEADER_HEIGHT - 5}
                    r={4}
                    fill="var(--status-critical)"
                  />
                )}
              </svg>
            </div>

            <svg width={svgWidth} height={bodyHeight} className="block">
            <defs>
              {/* Arrowhead for dependency links. */}
              <marker
                id="timeline-dep-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
              </marker>
              <marker
                id="timeline-dep-arrow-crit"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--status-critical)" />
              </marker>
              {/* Directional dependency arrows for the hover-focus view. */}
              <marker id="timeline-dep-arrow-up" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#f59e0b" />
              </marker>
              <marker id="timeline-dep-arrow-down" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#0ea5e9" />
              </marker>
              {/* Diagonal hatch overlay marking ENABLER work (architecture,
                  infra, compliance) — a texture that reads regardless of the
                  bar's type color. */}
              <pattern
                id="timeline-enabler-hatch"
                width="6"
                height="6"
                patternTransform="rotate(45)"
                patternUnits="userSpaceOnUse"
              >
                <rect width="6" height="6" fill="transparent" />
                <line x1="0" y1="0" x2="0" y2="6" stroke="white" strokeWidth="2" opacity="0.55" />
              </pattern>
            </defs>

            {/* Weekend shading + week gridlines */}
            {dateHeaders.map((h, i) => {
              const x = i * DAY_WIDTH;
              const isWeekend = h.date.getDay() === 0 || h.date.getDay() === 6;
              if (!isWeekend && !h.isWeekStart) return null;
              return (
                <g key={i}>
                  {isWeekend && (
                    <rect
                      x={x}
                      y={0}
                      width={DAY_WIDTH}
                      height={bodyHeight}
                      className="fill-muted/20"
                    />
                  )}
                  {h.isWeekStart && (
                    <line
                      x1={x}
                      y1={0}
                      x2={x}
                      y2={bodyHeight}
                      className="stroke-border/50"
                      strokeWidth={0.5}
                    />
                  )}
                </g>
              );
            })}

            {/* Row separators */}
            {sortedItems.map((_, i) => (
              <line
                key={i}
                x1={0}
                y1={(i + 1) * ROW_HEIGHT}
                x2={svgWidth}
                y2={(i + 1) * ROW_HEIGHT}
                className="stroke-border/30"
                strokeWidth={0.5}
              />
            ))}

            {/* Dependency links (prod-parity): a curved connector from the
                source bar's right edge to the target bar's left edge, with an
                arrowhead at the target. Rendered UNDER the bars. Endpoints whose
                bar isn't currently on a visible row are skipped. */}
            {(showDeps || showCritical) &&
              links.map((link) => {
                const from = barPositions.get(link.sourceItemId);
                const to = barPositions.get(link.targetItemId);
                if (!from || !to) return null;
                const x1 = from.x + from.w;
                const y1 = from.y + from.h / 2;
                const x2 = to.x;
                const y2 = to.y + to.h / 2;
                const midX = (x1 + x2) / 2;
                const crit =
                  showCritical &&
                  criticalSet.has(link.sourceItemId) &&
                  criticalSet.has(link.targetItemId);
                const downstream = !!depFocus && link.sourceItemId === depFocus.id;
                const upstream = !!depFocus && link.targetItemId === depFocus.id;
                // deps off: only the critical chain shows (when that lens is on).
                if (!crit && !showDeps) return null;
                let stroke = "#94a3b8";
                let sw = 1.25;
                let opacity = 0.34;
                let marker = "url(#timeline-dep-arrow)";
                if (crit) {
                  stroke = "var(--status-critical)";
                  sw = 2.5;
                  opacity = 1;
                  marker = "url(#timeline-dep-arrow-crit)";
                } else if (depFocus) {
                  if (downstream || upstream) {
                    stroke = downstream ? "#0ea5e9" : "#f59e0b";
                    sw = 2.5;
                    opacity = 1;
                    marker = downstream ? "url(#timeline-dep-arrow-down)" : "url(#timeline-dep-arrow-up)";
                  } else {
                    opacity = 0.06;
                    sw = 1;
                  }
                }
                return (
                  <path
                    key={link.id}
                    d={`M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`}
                    stroke={stroke}
                    strokeWidth={sw}
                    opacity={opacity}
                    fill="none"
                    markerEnd={marker}
                  >
                    <title>
                      {projectKey}-{link.sourceTicketNumber} {link.type}{" "}
                      {projectKey}-{link.targetTicketNumber}
                    </title>
                  </path>
                );
              })}

            {/* Work item bars */}
            {sortedItems.map((item, i) => {
              const start = item.startDate
                ? startOfDay(new Date(item.startDate))
                : startOfDay(new Date(item.createdAt));
              const end = item.dueDate
                ? startOfDay(new Date(item.dueDate))
                : addDays(start, 7);

              const startOffset = diffDays(timelineStart, start);
              const duration = Math.max(diffDays(start, end), 1);

              const baseX = startOffset * DAY_WIDTH;
              const y = i * ROW_HEIGHT + 8;
              const baseW = Math.max(duration * DAY_WIDTH, DAY_WIDTH);
              const h = ROW_HEIGHT - 16;

              // Apply the live drag preview to this bar's geometry (day-snapped),
              // clamped so a resize can't invert the bar.
              let x = baseX;
              let w = baseW;
              const preview = dragPreview?.id === item.id ? dragPreview : null;
              if (preview) {
                const px = preview.deltaDays * DAY_WIDTH;
                if (preview.mode === "move") {
                  x = baseX + px;
                } else if (preview.mode === "start") {
                  x = Math.min(baseX + px, baseX + baseW - DAY_WIDTH);
                  w = baseX + baseW - x;
                } else {
                  w = Math.max(baseW + px, DAY_WIDTH);
                }
              }

              const colors = typeColorMap[bareTypeKey(item.workItemType?.key)] ?? typeColorMap.TASK;
              const prog = progressOf(item, doneKeys);
              const isCrit = showCritical && criticalSet.has(item.id);
              const isEnabler = item.workCategory === "ENABLER";
              // Business items dim slightly while the Enabler lens is on so the
              // hatched enablers pop; enablers keep full opacity.
              const dimForEnablerLens = showEnablers && !isEnabler ? 0.4 : 1;
              // Dependency hover-focus: fade bars outside the hovered item neighborhood.
              const depDim = depFocus && !depFocus.all.has(item.id) ? 0.22 : 1;

              // PRIMARY (solid) = the ACTUAL span at real dates; the planned span
              // (startDate -> dueDate) renders behind it as a faded, health-colored
              // TRAIL — red when slipped, amber when it started late, green when
              // on/ahead. No red outline; the trail carries the signal. With no actuals
              // yet, the planned span IS the solid bar (future/planning items).
              const health = barHealth(item, today);
              const plannedStartD = item.startDate ? startOfDay(new Date(item.startDate)) : null;
              const actualStartD = item.actualStart ? startOfDay(new Date(item.actualStart)) : null;
              const actualEndD = item.completedAt ? startOfDay(new Date(item.completedAt)) : today;
              let actualBar: { x: number; w: number } | null = null;
              if (actualStartD) {
                const ax = diffDays(timelineStart, actualStartD) * DAY_WIDTH;
                const aw = Math.max(diffDays(actualStartD, actualEndD) * DAY_WIDTH, 3);
                actualBar = { x: ax, w: aw };
              }
              const primaryX = actualBar ? actualBar.x : x;
              const primaryW = actualBar ? actualBar.w : w;
              const lateStart = !!(plannedStartD && actualStartD && diffDays(plannedStartD, actualStartD) > 0);
              const trailColor =
                health === "red"
                  ? "var(--status-critical)"
                  : lateStart
                    ? "#f59e0b"
                    : "var(--status-done)";

              // Check if this is a milestone (same start and due date or type hint)
              const isMilestone =
                item.startDate &&
                item.dueDate &&
                item.startDate === item.dueDate;

              const enter = (e: React.MouseEvent) => {
                if (dragRef.current) return;
                setHoveredItem(item);
                setTooltipPos({ x: e.clientX, y: e.clientY });
              };

              if (isMilestone) {
                const cx = x + DAY_WIDTH / 2;
                const cy = y + h / 2;
                const size = 8;
                return (
                  <g
                    key={item.id}
                    onMouseEnter={enter}
                    onMouseLeave={() => setHoveredItem(null)}
                    onPointerDown={(e) => beginDrag(item, "move", e)}
                    onPointerMove={onDragMove}
                    onPointerUp={onDragEnd}
                    onPointerCancel={onDragCancel}
                    onClick={() => openDetail(item)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setHoveredItem(null);
                      setDetailId(item.id);
                    }}
                    style={{ touchAction: canEdit ? "none" : undefined }}
                    className={canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}
                  >
                    <polygon
                      points={`${cx},${cy - size} ${cx + size},${cy} ${cx},${cy + size} ${cx - size},${cy}`}
                      fill={colors.fill}
                      stroke={
                        isCrit
                          ? "var(--status-critical)"
                          : health === "red"
                            ? "var(--status-critical)"
                            : colors.stroke
                      }
                      strokeWidth={isCrit || health === "red" ? 2.5 : 1.5}
                    />
                  </g>
                );
              }

              const EDGE = 7;
              return (
                <g
                  key={item.id}
                  onMouseEnter={enter}
                  onMouseMove={(e) => {
                    if (dragRef.current) return;
                    setTooltipPos({ x: e.clientX, y: e.clientY });
                  }}
                  onMouseLeave={() => setHoveredItem(null)}
                >
                  {/* Planned bar. No actuals → it IS the item: solid + draggable.
                      Actuals exist → it becomes a faded, NON-interactive "Plan drift"
                      ghost, shown only when that lens is on (so you see how the plan
                      shifted). */}
                  {!actualBar ? (
                    <rect
                      x={x}
                      y={y}
                      width={w}
                      height={h}
                      rx={4}
                      fill={colors.fill}
                      stroke={
                        isCrit
                          ? "var(--status-critical)"
                          : isEnabler && showEnablers
                            ? "var(--type-enabler, #0891b2)"
                            : colors.stroke
                      }
                      strokeWidth={isCrit ? 2.5 : isEnabler ? 1.5 : 1}
                      strokeDasharray={isEnabler ? "5 3" : undefined}
                      opacity={(preview ? 1 : 0.85) * dimForEnablerLens * depDim}
                      onPointerDown={(e) => beginDrag(item, "move", e)}
                      onPointerMove={onDragMove}
                      onPointerUp={onDragEnd}
                      onPointerCancel={onDragCancel}
                      onClick={() => openDetail(item)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setHoveredItem(null);
                        setDetailId(item.id);
                      }}
                      style={{ touchAction: canEdit ? "none" : undefined }}
                      className={canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}
                    />
                  ) : showPlanDrift ? (
                    <rect
                      x={x}
                      y={y}
                      width={w}
                      height={h}
                      rx={4}
                      fill={trailColor}
                      stroke={isCrit ? "var(--status-critical)" : "transparent"}
                      strokeWidth={isCrit ? 2.5 : 1}
                      strokeDasharray="3 3"
                      opacity={0.3 * dimForEnablerLens * depDim}
                      style={{ pointerEvents: "none" }}
                    />
                  ) : null}
                  {/* Actual bar — the SOLID primary (real dates). Click opens the
                      detail panel; started/done items reschedule there, not by drag. */}
                  {actualBar && (
                    <rect
                      x={primaryX}
                      y={y}
                      width={primaryW}
                      height={h}
                      rx={4}
                      fill={colors.fill}
                      stroke={
                        isCrit
                          ? "var(--status-critical)"
                          : isEnabler && showEnablers
                            ? "var(--type-enabler, #0891b2)"
                            : colors.stroke
                      }
                      strokeWidth={isCrit ? 2.5 : isEnabler ? 1.5 : 1}
                      strokeDasharray={isEnabler ? "5 3" : undefined}
                      opacity={(preview ? 1 : 0.9) * dimForEnablerLens * depDim}
                      onClick={() => openDetail(item)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setHoveredItem(null);
                        setDetailId(item.id);
                      }}
                      className="cursor-pointer"
                    />
                  )}
                  {/* Progress fill on the primary — % complete. Non-interactive. */}
                  {prog > 0 && (
                    <rect
                      x={primaryX}
                      y={y}
                      width={Math.max(primaryW * prog, 2)}
                      height={h}
                      rx={4}
                      fill={colors.stroke}
                      opacity={preview ? 0.65 : 0.5}
                      style={{ pointerEvents: "none" }}
                    />
                  )}
                  {/* Enabler texture on the primary. */}
                  {isEnabler && (
                    <rect
                      x={primaryX}
                      y={y}
                      width={primaryW}
                      height={h}
                      rx={4}
                      fill="url(#timeline-enabler-hatch)"
                      opacity={showEnablers ? 1 : 0.6}
                      style={{ pointerEvents: "none" }}
                    />
                  )}
                  {canEdit && !actualBar && (
                    <>
                      {/* Left edge → move start date */}
                      <rect
                        x={x}
                        y={y}
                        width={EDGE}
                        height={h}
                        rx={4}
                        fill="transparent"
                        onPointerDown={(e) => beginDrag(item, "start", e)}
                        onPointerMove={onDragMove}
                        onPointerUp={onDragEnd}
                        onPointerCancel={onDragCancel}
                        style={{ cursor: "ew-resize", touchAction: "none" }}
                      />
                      {/* Right edge → move due date */}
                      <rect
                        x={x + w - EDGE}
                        y={y}
                        width={EDGE}
                        height={h}
                        rx={4}
                        fill="transparent"
                        onPointerDown={(e) => beginDrag(item, "end", e)}
                        onPointerMove={onDragMove}
                        onPointerUp={onDragEnd}
                        onPointerCancel={onDragCancel}
                        style={{ cursor: "ew-resize", touchAction: "none" }}
                      />
                    </>
                  )}
                  {primaryW > 60 && (
                    <text
                      x={primaryX + 6}
                      y={y + h / 2 + 3.5}
                      className={cn("text-[10px]", colors.text)}
                      style={{ fontSize: 10, fill: "white", pointerEvents: "none" }}
                    >
                      {item.title.length > Math.floor(primaryW / 6)
                        ? item.title.slice(0, Math.floor(primaryW / 6)) + "..."
                        : item.title}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Today marker — the dot sits in the sticky header SVG above. */}
            {todayOffset >= 0 && todayOffset < totalDays && (
              <line
                x1={todayOffset * DAY_WIDTH + DAY_WIDTH / 2}
                y1={0}
                x2={todayOffset * DAY_WIDTH + DAY_WIDTH / 2}
                y2={bodyHeight}
                stroke="var(--status-critical)"
                strokeWidth={2}
                strokeDasharray="4 2"
              />
            )}
            </svg>
          </div>

          {/* Hover tooltip */}
          {hoveredItem && (
            <div
              className="fixed z-50 rounded-lg bg-popover border shadow-lg p-3 pointer-events-none max-w-xs"
              style={{
                left: tooltipPos.x + 12,
                top: tooltipPos.y + 12,
              }}
            >
              <p className="text-sm font-medium mb-1">
                {projectKey}-{hoveredItem.ticketNumber}: {hoveredItem.title}
              </p>
              <div className="text-xs text-muted-foreground space-y-0.5">
                <p>
                  Type: {hoveredItem.workItemType?.name ?? "Unknown"}
                  {hoveredItem.workCategory === "ENABLER" && (
                    <span className="ml-1 rounded-sm bg-[var(--type-enabler)]/15 px-1 text-[var(--type-enabler)]">
                      Enabler
                    </span>
                  )}
                </p>
                <p>Priority: {hoveredItem.priority}</p>
                {hoveredItem.assigneeId && (
                  <p>Assignee: {memberMap.get(hoveredItem.assigneeId) ?? "Unknown"}</p>
                )}
                {hoveredItem.startDate && (
                  <p>Start: {new Date(hoveredItem.startDate).toLocaleDateString()}</p>
                )}
                {hoveredItem.dueDate && (
                  <p>Due: {new Date(hoveredItem.dueDate).toLocaleDateString()}</p>
                )}
                {/* Slippage — Actual End (or today) vs Projected End. */}
                {hoveredItem.dueDate &&
                  (() => {
                    const slip = slipDays({
                      projectedEnd: startOfDay(new Date(hoveredItem.dueDate)),
                      actualEnd: hoveredItem.completedAt
                        ? startOfDay(new Date(hoveredItem.completedAt))
                        : null,
                      now: today,
                    });
                    if (slip === null) return null;
                    if (slip === 0) return <p>On schedule</p>;
                    return (
                      <p className={slip > 0 ? "text-[var(--status-critical)]" : "text-[var(--status-done)]"}>
                        {slip > 0 ? `Slipped ${slip}d late` : `${-slip}d ahead of plan`}
                      </p>
                    );
                  })()}
                {/* Start delta — Actual Start later than Planned Start (slow start). */}
                {hoveredItem.startDate &&
                  hoveredItem.actualStart &&
                  (() => {
                    const sd = Math.round(
                      (startOfDay(new Date(hoveredItem.actualStart)).getTime() -
                        startOfDay(new Date(hoveredItem.startDate)).getTime()) /
                        86_400_000,
                    );
                    if (sd <= 0) return null;
                    const fSlip = hoveredItem.dueDate
                      ? slipDays({
                          projectedEnd: startOfDay(new Date(hoveredItem.dueDate)),
                          actualEnd: hoveredItem.completedAt
                            ? startOfDay(new Date(hoveredItem.completedAt))
                            : null,
                          now: today,
                        })
                      : null;
                    const recovered =
                      hoveredItem.completedAt != null && fSlip != null && fSlip <= 0;
                    return (
                      <p className="text-[#f59e0b]">
                        Started {sd}d late{recovered ? " — recovered ✓" : ""}
                      </p>
                    );
                  })()}
                {hoveredItem.actualStart && (
                  <p>Actual start: {new Date(hoveredItem.actualStart).toLocaleDateString()}</p>
                )}
                {hoveredItem.completedAt && (
                  <p>Actual end: {new Date(hoveredItem.completedAt).toLocaleDateString()}</p>
                )}
                {hoveredItem.storyPoints != null && (
                  <p>Points: {hoveredItem.storyPoints}</p>
                )}
              </div>
            </div>
          )}
      </div>

      {/* Shared work-item detail — same sheet the Kanban/Table views use, so a
          ticket opened from the Timeline shows + edits identical data (FR). */}
      <CardDetailSheet
        item={detailItem}
        open={detailItem !== null}
        onOpenChange={(o) => !o && setDetailId(null)}
        orgId={orgId}
        projectId={projectId}
        members={members}
        cycles={cycles}
        columns={columns}
        projectItems={items}
        onUpdate={(updated) =>
          qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
            prev?.map((it) => (it.id === updated.id ? updated : it)),
          )
        }
        onDelete={(id) => {
          qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
            prev?.filter((it) => it.id !== id),
          );
          setDetailId(null);
        }}
        onItemCreated={() => qc.invalidateQueries({ queryKey: itemsKey })}
        onChildrenReordered={() => qc.invalidateQueries({ queryKey: itemsKey })}
        onOpenItem={(id) => setDetailId(id)}
      />
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 flex overflow-hidden">
        <div className="shrink-0 border-r w-[260px] space-y-2 p-3">
          <Skeleton className="h-8 w-full" />
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
        <div className="flex-1 p-3">
          <Skeleton className="h-full w-full" />
        </div>
      </div>
    </div>
  );
}
