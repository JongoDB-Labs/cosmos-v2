"use client";

import { useState, useMemo, useRef, useCallback } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { notifyError } from "@/lib/errors/notify";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { cn } from "@/lib/utils";
import type { WorkItem, OrgMember, Cycle, Board, BoardColumn } from "@/types/models";
import { bareTypeKey } from "@/components/boards/shared/filter-bar";
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

export function TimelineView({ orgId, projectId, projectKey, boardId }: TimelineViewProps) {
  const [hoveredItem, setHoveredItem] = useState<WorkItem | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);

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

  const items: WorkItem[] = itemsQ.data ?? [];
  const members: OrgMember[] = membersQ.data ?? [];
  const links: WorkItemLink[] = linksQ.data ?? [];
  const columns: BoardColumn[] = boardQ.data?.columns ?? [];
  const cycles: Cycle[] = cyclesQ.data ?? [];

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
      map.set(m.userId, m.user?.displayName ?? m.userId);
    }
    return map;
  }, [members]);

  // Compute timeline range
  const { timelineStart, timelineEnd, totalDays, sortedItems } = useMemo(() => {
    if (items.length === 0) {
      const now = startOfDay(new Date());
      return {
        timelineStart: addDays(now, -7),
        timelineEnd: addDays(now, 30),
        totalDays: 37,
        sortedItems: [],
      };
    }

    let minDate = new Date();
    let maxDate = new Date();

    for (const item of items) {
      const start = item.startDate ? new Date(item.startDate) : new Date(item.createdAt);
      const end = item.dueDate ? new Date(item.dueDate) : addDays(start, 7);

      if (start < minDate) minDate = start;
      if (end > maxDate) maxDate = end;
    }

    // Add padding
    const padStart = addDays(startOfDay(minDate), -3);
    const padEnd = addDays(startOfDay(maxDate), 7);
    const days = Math.max(diffDays(padStart, padEnd), 30);

    const sorted = [...items].sort((a, b) => {
      const aStart = a.startDate ?? a.createdAt;
      const bStart = b.startDate ?? b.createdAt;
      return new Date(aStart).getTime() - new Date(bStart).getTime();
    });

    return {
      timelineStart: padStart,
      timelineEnd: padEnd,
      totalDays: days,
      sortedItems: sorted,
    };
  }, [items]);

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
        y: HEADER_HEIGHT + i * ROW_HEIGHT + 8,
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

  const today = startOfDay(new Date());
  const todayOffset = diffDays(timelineStart, today);

  const svgWidth = totalDays * DAY_WIDTH;
  const svgHeight = HEADER_HEIGHT + sortedItems.length * ROW_HEIGHT + 20;

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

  if (sortedItems.length === 0) {
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
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
        {canEdit ? (
          <p className="hidden text-xs text-muted-foreground sm:block">
            Drag a bar to reschedule · drag its edges to resize
          </p>
        ) : (
          <span />
        )}
        <CreateIssueButton
          orgId={orgId}
          projectId={projectId}
          boardId={boardId}
          onCreated={() => qc.invalidateQueries({ queryKey: itemsKey })}
        />
      </div>
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel - item labels. Narrower on phones so the chart isn't
            crowded off-screen; the SVG rows align by height, not this width. */}
        <div className="shrink-0 border-r bg-background overflow-y-auto w-[140px] sm:w-[260px]">
          <div
            className="border-b bg-muted/50 flex items-center px-3 text-xs font-medium text-muted-foreground"
            style={{ height: HEADER_HEIGHT }}
          >
            Work Items
          </div>
          {sortedItems.map((item) => {
            const colors = typeColorMap[bareTypeKey(item.workItemType?.key)] ?? typeColorMap.TASK;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setDetailId(item.id)}
                title={`${projectKey}-${item.ticketNumber}: ${item.title}`}
                className="flex w-full items-center gap-2 px-3 text-left border-b border-border/30 hover:bg-muted/30 transition-colors"
                style={{ height: ROW_HEIGHT }}
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
            );
          })}
        </div>

        {/* Right panel - timeline SVG */}
        <div ref={scrollRef} className="flex-1 overflow-auto relative">
          <svg
            width={svgWidth}
            height={svgHeight}
            className="block"
          >
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
            </defs>

            {/* Month headers */}
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

            {/* Day columns */}
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
                      height={svgHeight - 24}
                      className="fill-muted/20"
                    />
                  )}
                  {h.isWeekStart && (
                    <line
                      x1={x}
                      y1={24}
                      x2={x}
                      y2={svgHeight}
                      className="stroke-border/50"
                      strokeWidth={0.5}
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

            {/* Header separator */}
            <line
              x1={0}
              y1={HEADER_HEIGHT}
              x2={svgWidth}
              y2={HEADER_HEIGHT}
              className="stroke-border"
              strokeWidth={1}
            />

            {/* Row separators */}
            {sortedItems.map((_, i) => (
              <line
                key={i}
                x1={0}
                y1={HEADER_HEIGHT + (i + 1) * ROW_HEIGHT}
                x2={svgWidth}
                y2={HEADER_HEIGHT + (i + 1) * ROW_HEIGHT}
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
              return (
                <path
                  key={link.id}
                  d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                  className="stroke-muted-foreground/60"
                  strokeWidth={1.5}
                  fill="none"
                  markerEnd="url(#timeline-dep-arrow)"
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
              const y = HEADER_HEIGHT + i * ROW_HEIGHT + 8;
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
                      stroke={colors.stroke}
                      strokeWidth={1.5}
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
                    stroke={colors.stroke}
                    strokeWidth={1}
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

            {/* Today marker */}
            {todayOffset >= 0 && todayOffset < totalDays && (
              <>
                <line
                  x1={todayOffset * DAY_WIDTH + DAY_WIDTH / 2}
                  y1={HEADER_HEIGHT}
                  x2={todayOffset * DAY_WIDTH + DAY_WIDTH / 2}
                  y2={svgHeight}
                  stroke="var(--status-critical)"
                  strokeWidth={2}
                  strokeDasharray="4 2"
                />
                <circle
                  cx={todayOffset * DAY_WIDTH + DAY_WIDTH / 2}
                  cy={HEADER_HEIGHT}
                  r={4}
                  fill="var(--status-critical)"
                />
              </>
            )}
          </svg>

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
