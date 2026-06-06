"use client";

import { useState, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { WorkItem, OrgMember } from "@/types/models";

interface CalendarViewProps {
  orgId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
}

const priorityColorMap: Record<string, string> = {
  CRITICAL: "bg-red-500",
  HIGH: "bg-orange-500",
  MEDIUM: "bg-blue-500",
  LOW: "bg-muted-foreground/60",
};

const priorityBorderMap: Record<string, string> = {
  CRITICAL: "border-l-red-500",
  HIGH: "border-l-orange-500",
  MEDIUM: "border-l-blue-500",
  LOW: "border-l-muted-foreground/40",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function CalendarView({ orgId, projectId, projectKey, boardId }: CalendarViewProps) {
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [expandedDay, setExpandedDay] = useState<string | null>(null);

  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  const itemsKey = useOrgQueryKey("work-items", projectId);
  const membersKey = useOrgQueryKey("members");

  const [itemsQ, membersQ] = useQueries({
    queries: [
      {
        queryKey: itemsKey,
        queryFn: () => jsonFetch<WorkItem[]>(`${basePath}/work-items`),
      },
      {
        queryKey: membersKey,
        queryFn: () => jsonFetch<OrgMember[]>(`/api/v1/orgs/${orgId}/members`),
      },
    ],
  });

  const items: WorkItem[] = itemsQ.data ?? [];
  const members: OrgMember[] = membersQ.data ?? [];
  const loading = itemsQ.isLoading || membersQ.isLoading;
  const error = itemsQ.error
    ? itemsQ.error instanceof Error
      ? itemsQ.error.message
      : "Unknown error"
    : null;

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfWeek(year, month);
  const today = new Date();

  // Map items to dates by dueDate or startDate
  const dateItemsMap = useMemo(() => {
    const map = new Map<string, WorkItem[]>();
    for (const item of items) {
      const dateStr = item.dueDate ?? item.startDate;
      if (!dateStr) continue;
      const d = new Date(dateStr);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const existing = map.get(key) ?? [];
      existing.push(item);
      map.set(key, existing);
    }
    return map;
  }, [items]);

  const memberMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      map.set(m.userId, m.user?.displayName ?? m.userId);
    }
    return map;
  }, [members]);

  function navigateMonth(offset: number) {
    setCurrentDate((prev) => {
      const d = new Date(prev);
      d.setMonth(d.getMonth() + offset);
      return d;
    });
    setExpandedDay(null);
  }

  // Build calendar grid cells
  const calendarCells: Array<{ day: number | null; key: string }> = [];
  for (let i = 0; i < firstDay; i++) {
    calendarCells.push({ day: null, key: `empty-${i}` });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    calendarCells.push({ day: d, key: `day-${d}` });
  }
  // Pad to fill last row
  while (calendarCells.length % 7 !== 0) {
    calendarCells.push({ day: null, key: `pad-${calendarCells.length}` });
  }

  if (loading) return <CalendarSkeleton />;

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

  const expandedDayItems = expandedDay ? dateItemsMap.get(expandedDay) ?? [] : [];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-background/50">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon-xs" onClick={() => navigateMonth(-1)}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <h2 className="text-sm font-semibold min-w-[140px] text-center">
            {currentDate.toLocaleString("default", { month: "long", year: "numeric" })}
          </h2>
          <Button variant="outline" size="icon-xs" onClick={() => navigateMonth(1)}>
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            setCurrentDate(new Date());
            setExpandedDay(null);
          }}
        >
          Today
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {/* Weekday headers */}
        <div className="grid grid-cols-7 gap-px mb-1">
          {WEEKDAYS.map((day) => (
            <div
              key={day}
              className="text-center text-xs font-medium text-muted-foreground py-2"
            >
              {day}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="grid grid-cols-7 gap-px bg-border/50 rounded-lg overflow-hidden">
          {calendarCells.map((cell) => {
            if (cell.day === null) {
              return (
                <div key={cell.key} className="min-h-[100px] bg-background/30" />
              );
            }

            const dateKey = `${year}-${month}-${cell.day}`;
            const dayItems = dateItemsMap.get(dateKey) ?? [];
            const isToday = isSameDay(
              new Date(year, month, cell.day),
              today
            );
            const isExpanded = expandedDay === dateKey;
            const isWeekend = new Date(year, month, cell.day).getDay() % 6 === 0;

            return (
              <div
                key={cell.key}
                className={cn(
                  "min-h-[100px] bg-background p-1.5 transition-colors",
                  isWeekend && "bg-muted/20",
                  isExpanded && "ring-2 ring-primary/50"
                )}
              >
                <div className="flex items-center justify-between mb-1">
                  <span
                    className={cn(
                      "text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full",
                      isToday && "bg-primary text-primary-foreground"
                    )}
                  >
                    {cell.day}
                  </span>
                  {dayItems.length > 0 && (
                    <button
                      type="button"
                      className="text-[10px] text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        setExpandedDay(isExpanded ? null : dateKey)
                      }
                    >
                      {dayItems.length} item{dayItems.length !== 1 ? "s" : ""}
                    </button>
                  )}
                </div>

                {/* Show up to 3 items */}
                <div className="space-y-0.5">
                  {dayItems.slice(0, 3).map((item) => (
                    <div
                      key={item.id}
                      className={cn(
                        "text-[10px] leading-tight px-1.5 py-0.5 rounded border-l-2 truncate bg-muted/40",
                        priorityBorderMap[item.priority]
                      )}
                      title={`${projectKey}-${item.ticketNumber}: ${item.title}`}
                    >
                      {item.title}
                    </div>
                  ))}
                  {dayItems.length > 3 && (
                    <button
                      type="button"
                      className="text-[10px] text-muted-foreground hover:text-foreground pl-1.5"
                      onClick={() => setExpandedDay(dateKey)}
                    >
                      +{dayItems.length - 3} more
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Expanded day detail panel */}
        {expandedDay && expandedDayItems.length > 0 && (
          <div className="mt-4 rounded-lg border bg-background p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">
                {(() => {
                  const parts = expandedDay.split("-");
                  const d = new Date(
                    Number(parts[0]),
                    Number(parts[1]),
                    Number(parts[2])
                  );
                  return d.toLocaleDateString("default", {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                  });
                })()}
              </h3>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setExpandedDay(null)}
              >
                <span className="sr-only">Close</span>
                &times;
              </Button>
            </div>
            <div className="space-y-2">
              {expandedDayItems.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    "flex items-center gap-3 rounded-md border p-2 border-l-4",
                    priorityBorderMap[item.priority]
                  )}
                >
                  <div
                    className={cn(
                      "w-2 h-2 rounded-full shrink-0",
                      priorityColorMap[item.priority]
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {projectKey}-{item.ticketNumber}
                      {item.assigneeId && (
                        <> &middot; {memberMap.get(item.assigneeId) ?? "Unknown"}</>
                      )}
                    </p>
                  </div>
                  <Badge className={cn("text-[10px] shrink-0", priorityColorMap[item.priority] === "bg-red-500" ? "bg-red-500/20 text-red-400" : priorityColorMap[item.priority] === "bg-orange-500" ? "bg-orange-500/20 text-orange-400" : priorityColorMap[item.priority] === "bg-blue-500" ? "bg-blue-500/20 text-blue-400" : "bg-muted text-muted-foreground")}>
                    {item.priority}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CalendarSkeleton() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-6" />
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-6 w-6" />
        </div>
        <Skeleton className="h-6 w-16" />
      </div>
      <div className="flex-1 p-4">
        <div className="grid grid-cols-7 gap-px">
          {Array.from({ length: 35 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      </div>
    </div>
  );
}
