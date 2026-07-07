"use client";

import { useState, useMemo, useRef, useCallback } from "react";
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
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { notifyError } from "@/lib/errors/notify";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { cn } from "@/lib/utils";
import type { WorkItem, OrgMember, Cycle, Board, BoardColumn } from "@/types/models";
import {
  bareTypeKey,
  FilterBar,
  emptyFilters,
  type BoardFilters,
} from "@/components/boards/shared/filter-bar";
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

/** Client-side board-filter match (search/type/priority/assignee/cycle) — mirrors
 *  the Kanban/Table logic so the Gantt's FilterBar behaves identically. Custom
 *  fields aren't surfaced on the Gantt, so they're not applied here. */
function matchesFilters(item: WorkItem, f: BoardFilters): boolean {
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

export function TimelineView({ orgId, projectId, projectKey, boardId }: TimelineViewProps) {
  const [hoveredItem, setHoveredItem] = useState<WorkItem | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);

  // Keep the left item-list and the right Gantt chart vertically in lockstep —
  // their rows share ROW_HEIGHT, so mirroring scrollTop keeps each label aligned
  // with its bar. Only the vertical axis syncs (the chart also scrolls
  // horizontally). The equality guard stops the mirrored set from looping.
  const syncScroll = useCallback((from: "left" | "right") => {
    const src = from === "left" ? leftRef.current : scrollRef.current;
    const dst = from === "left" ? scrollRef.current : leftRef.current;
    if (src && dst && dst.scrollTop !== src.scrollTop) dst.scrollTop = src.scrollTop;
  }, []);

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
  const members = useMemo<OrgMember[]>(() => membersQ.data ?? [], [membersQ.data]);
  const links = useMemo<WorkItemLink[]>(() => linksQ.data ?? [], [linksQ.data]);
  const columns = useMemo<BoardColumn[]>(() => boardQ.data?.columns ?? [], [boardQ.data]);
  const cycles = useMemo<Cycle[]>(() => cyclesQ.data ?? [], [cyclesQ.data]);

  // ── Gantt controls ───────────────────────────────────────────────────────
  // FilterBar filters (search/type/priority/assignee/cycle), a critical-path
  // highlight toggle, and a busy flag while a bulk shift/compress is in flight.
  const [filters, setFilters] = useState<BoardFilters>(emptyFilters);
  const [showCritical, setShowCritical] = useState(false);
  const [busy, setBusy] = useState(false);

  const filteredItems = useMemo(
    () => items.filter((it) => matchesFilters(it, filters)),
    [items, filters],
  );

  // ── Hierarchy rows (FR f396a6a9) ─────────────────────────────────────────
  // Depth-first parent→children row order with per-parent collapse. Collapsing a
  // parent hides its whole subtree (rows, bars, and arrows all key off the row
  // list). A child whose parent is filtered out surfaces as a root so a filter
  // can never hide items silently.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  const { treeRows, parentIds } = useMemo(() => {
    const byId = new Map(filteredItems.map((i) => [i.id, i]));
    const kids = new Map<string, WorkItem[]>();
    const roots: WorkItem[] = [];
    for (const it of filteredItems) {
      if (it.parentId && byId.has(it.parentId)) {
        const arr = kids.get(it.parentId) ?? [];
        arr.push(it);
        kids.set(it.parentId, arr);
      } else {
        roots.push(it);
      }
    }
    const byStart = (a: WorkItem, b: WorkItem) =>
      new Date(a.startDate ?? a.createdAt).getTime() -
      new Date(b.startDate ?? b.createdAt).getTime();
    roots.sort(byStart);
    for (const arr of kids.values()) arr.sort(byStart);

    const rows: { item: WorkItem; depth: number }[] = [];
    const seen = new Set<string>(); // cycle guard (bad parentId data can't hang us)
    const walk = (it: WorkItem, depth: number) => {
      if (seen.has(it.id)) return;
      seen.add(it.id);
      rows.push({ item: it, depth });
      if (collapsedIds.has(it.id)) return;
      for (const k of kids.get(it.id) ?? []) walk(k, depth + 1);
    };
    for (const r of roots) walk(r, 0);
    return { treeRows: rows, parentIds: new Set(kids.keys()) };
  }, [filteredItems, collapsedIds]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const doneKeys = useMemo(
    () => new Set(columns.filter((c) => c.category === "DONE").map((c) => c.key)),
    [columns],
  );

  // Click a bar → open the shared work-item detail (same as other board views).
  // Tracked by id + derived from the live items so edits/deletes stay in sync.
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailItem = detailId
    ? items.find((i) => i.id === detailId) ?? null
    : null;
  // A real drag (movement) also fires a trailing click — suppress it so a
  // reschedule/resize doesn't pop the detail sheet.
  const justDraggedRef = useRef(false);
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

  const sortedItems = useMemo(() => treeRows.map((r) => r.item), [treeRows]);

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
    sortedItems.forEach((item, i) => {
      const start = item.startDate
        ? startOfDay(new Date(item.startDate))
        : startOfDay(new Date(item.createdAt));
      const end = item.dueDate ? startOfDay(new Date(item.dueDate)) : addDays(start, 7);
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
      };
      setDragPreview({ id: item.id, mode, deltaDays: 0 });
      setHoveredItem(null);
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    },
    [canEdit],
  );

  const onDragMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
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

      const body: { startDate?: string; dueDate?: string } =
        d.mode === "start"
          ? { startDate: newStart.toISOString() }
          : d.mode === "end"
            ? { dueDate: newEnd.toISOString() }
            : { startDate: newStart.toISOString(), dueDate: newEnd.toISOString() };

      // Optimistic: patch the cached item so the bar settles at its new spot
      // immediately, then persist.
      qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
        prev?.map((it) => (it.id === d.id ? { ...it, ...body } : it)),
      );

      void (async () => {
        try {
          await jsonFetch(`${basePath}/work-items/${d.id}`, {
            method: "PUT",
            body: JSON.stringify(body),
          });
          toast.success("Schedule updated");
          qc.invalidateQueries({ queryKey: itemsKey });
        } catch (err) {
          notifyError(err, "Couldn't reschedule the item.");
          qc.invalidateQueries({ queryKey: itemsKey }); // revert to server truth
        }
      })();
    },
    [qc, itemsKey, basePath],
  );

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
      />
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setShowCritical((v) => !v)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
              showCritical
                ? "border-[var(--status-critical)] bg-[var(--status-critical)]/10 text-[var(--status-critical)]"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
            title="Highlight the longest dependency chain"
          >
            <Route className="size-3.5" /> Critical path
          </button>
          {parentIds.size > 0 && (
            <button
              onClick={() =>
                setCollapsedIds((prev) => (prev.size > 0 ? new Set() : new Set(parentIds)))
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
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel - item labels. Narrower on phones so the chart isn't
            crowded off-screen; the SVG rows align by height, not this width. */}
        <div
          ref={leftRef}
          onScroll={() => syncScroll("left")}
          data-testid="gantt-left"
          className="shrink-0 border-r bg-background overflow-y-auto w-[140px] sm:w-[260px]"
        >
          <div
            className="sticky top-0 z-10 border-b bg-[var(--surface)] flex items-center px-3 text-xs font-medium text-muted-foreground"
            style={{ height: HEADER_HEIGHT }}
          >
            Work Items
          </div>
          {treeRows.map(({ item, depth }) => {
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
        </div>

        {/* Right panel - timeline SVG */}
        <div
          ref={scrollRef}
          onScroll={() => syncScroll("right")}
          data-testid="gantt-right"
          className="flex-1 overflow-auto relative"
        >
          <div style={{ width: svgWidth }}>
            {/* Sticky date header (FR e4d1732e): pinned while scrolling down,
                but scrolls horizontally with the chart because it sits inside
                the svgWidth wrapper — sticky only pins the vertical axis. */}
            <div
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
            {links.map((link) => {
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
              return (
                <path
                  key={link.id}
                  d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                  className={crit ? undefined : "stroke-muted-foreground/60"}
                  stroke={crit ? "var(--status-critical)" : undefined}
                  strokeWidth={crit ? 2.5 : 1.5}
                  fill="none"
                  markerEnd={crit ? "url(#timeline-dep-arrow-crit)" : "url(#timeline-dep-arrow)"}
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
                      stroke={isCrit ? "var(--status-critical)" : colors.stroke}
                      strokeWidth={isCrit ? 2.5 : 1.5}
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
                  <rect
                    x={x}
                    y={y}
                    width={w}
                    height={h}
                    rx={4}
                    fill={colors.fill}
                    stroke={isCrit ? "var(--status-critical)" : colors.stroke}
                    strokeWidth={isCrit ? 2.5 : 1}
                    opacity={preview ? 1 : 0.85}
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
                  {/* Progress fill — a darker inset showing % complete (child
                      roll-up, or done/not-done for a leaf). Non-interactive so it
                      never intercepts a drag on the bar. */}
                  {prog > 0 && (
                    <rect
                      x={x}
                      y={y}
                      width={Math.max(w * prog, 2)}
                      height={h}
                      rx={4}
                      fill={colors.stroke}
                      opacity={preview ? 0.65 : 0.5}
                      style={{ pointerEvents: "none" }}
                    />
                  )}
                  {canEdit && (
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
                  {w > 60 && (
                    <text
                      x={x + 6}
                      y={y + h / 2 + 3.5}
                      className={cn("text-[10px]", colors.text)}
                      style={{ fontSize: 10, fill: "white", pointerEvents: "none" }}
                    >
                      {item.title.length > Math.floor(w / 6)
                        ? item.title.slice(0, Math.floor(w / 6)) + "..."
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
                <p>Type: {hoveredItem.workItemType?.name ?? "Unknown"}</p>
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
                {hoveredItem.storyPoints != null && (
                  <p>Points: {hoveredItem.storyPoints}</p>
                )}
              </div>
            </div>
          )}
        </div>
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
