"use client";

import { useState, useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { cn } from "@/lib/utils";
import type { WorkItem, OrgMember } from "@/types/models";

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
const LEFT_PANEL_WIDTH = 260;
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

export function TimelineView({ orgId, projectId, projectKey, boardId }: TimelineViewProps) {
  const [hoveredItem, setHoveredItem] = useState<WorkItem | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);

  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  const itemsKey = useOrgQueryKey("work-items", projectId);
  const membersKey = useOrgQueryKey("members");
  const linksKey = useOrgQueryKey("work-item-links", projectId);

  const [itemsQ, membersQ, linksQ] = useQueries({
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
    ],
  });

  const items: WorkItem[] = itemsQ.data ?? [];
  const members: OrgMember[] = membersQ.data ?? [];
  const links: WorkItemLink[] = linksQ.data ?? [];
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
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel - item labels */}
        <div
          className="shrink-0 border-r bg-background overflow-y-auto"
          style={{ width: LEFT_PANEL_WIDTH }}
        >
          <div
            className="border-b bg-muted/50 flex items-center px-3 text-xs font-medium text-muted-foreground"
            style={{ height: HEADER_HEIGHT }}
          >
            Work Items
          </div>
          {sortedItems.map((item) => {
            const colors = typeColorMap[item.workItemType?.key ?? ""] ?? typeColorMap.TASK;
            return (
              <div
                key={item.id}
                className="flex items-center gap-2 px-3 border-b border-border/30 hover:bg-muted/30 transition-colors"
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
              </div>
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

              const x = startOffset * DAY_WIDTH;
              const y = HEADER_HEIGHT + i * ROW_HEIGHT + 8;
              const w = Math.max(duration * DAY_WIDTH, DAY_WIDTH);
              const h = ROW_HEIGHT - 16;

              const colors = typeColorMap[item.workItemType?.key ?? ""] ?? typeColorMap.TASK;

              // Check if this is a milestone (same start and due date or type hint)
              const isMilestone =
                item.startDate &&
                item.dueDate &&
                item.startDate === item.dueDate;

              if (isMilestone) {
                const cx = x + DAY_WIDTH / 2;
                const cy = y + h / 2;
                const size = 8;
                return (
                  <g
                    key={item.id}
                    onMouseEnter={(e) => {
                      setHoveredItem(item);
                      setTooltipPos({ x: e.clientX, y: e.clientY });
                    }}
                    onMouseLeave={() => setHoveredItem(null)}
                    className="cursor-pointer"
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

              return (
                <g
                  key={item.id}
                  onMouseEnter={(e) => {
                    setHoveredItem(item);
                    setTooltipPos({ x: e.clientX, y: e.clientY });
                  }}
                  onMouseMove={(e) => {
                    setTooltipPos({ x: e.clientX, y: e.clientY });
                  }}
                  onMouseLeave={() => setHoveredItem(null)}
                  className="cursor-pointer"
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
                    opacity={0.85}
                  />
                  {w > 60 && (
                    <text
                      x={x + 6}
                      y={y + h / 2 + 3.5}
                      className={cn("text-[10px]", colors.text)}
                      style={{ fontSize: 10, fill: "white" }}
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
