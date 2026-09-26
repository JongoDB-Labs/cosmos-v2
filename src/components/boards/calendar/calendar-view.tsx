"use client";

import { useState, useMemo } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { BoardItemDetailSheet } from "@/components/work-items/board-item-detail-sheet";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { FilterBar, emptyFilters, type BoardFilters } from "@/components/boards/shared/filter-bar";
import { matchesFilters } from "@/lib/work-items/board-filters";
import { useProjectStatuses } from "@/hooks/use-project-statuses";
import { NewIssueButton } from "@/components/boards/shared/new-issue-button";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { highlightColor, highlightLabel } from "@/lib/work-items/highlights";
import { commitState, eventDay, isTentative, type CommitState } from "@/lib/work-items/pi-commit";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { WorkItem, OrgMember, Interval } from "@/types/models";

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

/**
 * The highlight, as a ring ONLY — no `borderColor`.
 *
 * Every item on this view already carries `priorityBorderMap` on its LEFT
 * edge, and `highlightStyle()` sets `borderColor` on all four sides, which
 * would silently repaint priority's edge in the highlight colour. Two different
 * meanings competing for one border is worse than either alone, so the
 * highlight takes the inset ring and priority keeps the left edge.
 */
function calendarHighlightStyle(value: unknown): React.CSSProperties | undefined {
  const color = highlightColor(value);
  return color ? { boxShadow: `inset 0 0 0 2px ${color}` } : undefined;
}

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

/**
 * A grid cell's key (`year-monthIndex-day`, month 0-based) for a `YYYY-MM-DD`.
 *
 * This is the ONLY way an item reaches a cell. It used to be
 * `new Date(iso)` + `getMonth()`/`getDate()` — local parts off a full instant,
 * which is precisely what `src/lib/time/date-only.ts` says never to do, and the
 * grid was the last caller still doing it.
 *
 * It mattered here because the cell an item is drawn in and the day the Commit
 * control reasons about were computed two different ways. A due date stored at
 * UTC midnight (seeds and imports write those; only the app's own date pickers
 * use midday) reads one day EARLIER in local parts anywhere west of UTC — so in
 * America/New_York a panel headed "Sunday, September 20" carried a Commit button
 * refusing "2026-09-21", and an event due Sep 1 was drawn on Aug 31 and dropped
 * out of September altogether. Same defect twice: two answers to one question.
 *
 * Now both sides read `eventDay`, so there is one answer and the header, the
 * cell and the button cannot disagree.
 */
function cellKeyForDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return `${year}-${month - 1}-${date}`;
}

export function CalendarView({ orgId, projectId, projectKey, boardId }: CalendarViewProps) {
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [expandedDay, setExpandedDay] = useState<string | null>(null);

  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  const qc = useQueryClient();
  // A scheduled item is a work item; clicking it opens the full editable sheet
  // rather than being a read-only date marker.
  const [detailId, setDetailId] = useState<string | null>(null);
  const itemsKey = useOrgQueryKey("work-items", projectId);
  const membersKey = useOrgQueryKey("members");
  // Intervals, so a tentative event knows which PI board it would land on.
  const intervalsKey = useOrgQueryKey("intervals", projectId);

  const [itemsQ, membersQ, intervalsQ] = useQueries({
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
        queryKey: intervalsKey,
        queryFn: () => jsonFetch<Interval[]>(`${basePath}/intervals`),
      },
    ],
  });

  const items: WorkItem[] = itemsQ.data ?? [];
  const intervals = useMemo<Interval[]>(() => intervalsQ.data ?? [], [intervalsQ.data]);

  // One filter model, one predicate — the same `matchesFilters` the Timeline
  // uses. A board that filters differently from its neighbours is worse than a
  // board that does not filter at all.
  const [filters, setFilters] = useState<BoardFilters>(emptyFilters);
  // "A view of tentative events": narrows the month to the pencilled-in work —
  // dated, but not yet owned by any interval. Layered on top of the shared
  // FilterBar rather than inside it, because it is a property of THIS board's
  // planning question, not a facet every board has.
  const [tentativeOnly, setTentativeOnly] = useState(false);
  const projectStatuses = useProjectStatuses(orgId, projectId);
  const visibleItems = useMemo(
    () =>
      items.filter(
        (it) => matchesFilters(it, filters) && (!tentativeOnly || isTentative(it)),
      ),
    [items, filters, tentativeOnly],
  );
  const members: OrgMember[] = membersQ.data ?? [];
  const loading = itemsQ.isLoading || membersQ.isLoading || intervalsQ.isLoading;
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
    for (const item of visibleItems) {
      // `eventDay` — the same due-then-start reading the Commit control uses.
      const day = eventDay(item);
      if (!day) continue;
      const key = cellKeyForDay(day);
      const existing = map.get(key) ?? [];
      existing.push(item);
      map.set(key, existing);
    }
    return map;
  }, [visibleItems]);

  const memberMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      map.set(m.userId, m.user?.displayName ?? m.user?.email ?? "Unknown");
    }
    return map;
  }, [members]);

  const intervalNames = useMemo(
    () => new Map(intervals.map((i) => [i.id, i.name])),
    [intervals],
  );

  const { can } = usePermissions();
  const canCommit = can(Permission.ITEM_UPDATE);

  /**
   * Commit a tentative event onto the PI board that covers its dates.
   *
   * Deliberately the ordinary work-item PUT — the same call the Issues list's
   * "Move to interval" makes — rather than a commit-specific endpoint. That
   * route already writes the activity trail and publishes the org SSE that keeps
   * every other open board in sync (COSMOS-107); a second write path would have
   * to re-earn both, and would drift from them the first time either changed.
   */
  const commit = useOrgMutation({
    mutationFn: ({ item, interval }: { item: WorkItem; interval: { id: string; name: string } }) =>
      jsonFetch(`${basePath}/work-items/${item.id}`, {
        method: "PUT",
        body: JSON.stringify({ intervalId: interval.id }),
      }),
    invalidate: [["work-items", projectId]],
    onSuccess: (_data, vars) => {
      toast.success(`Committed to ${vars.interval.name}`);
    },
  });

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
      <div className="border-b px-4 py-2">
        <FilterBar
          filters={filters}
          onFilterChange={setFilters}
          members={members}
          intervals={[]}
          teams={[]}
          orgId={orgId}
          boardColumns={projectStatuses}
        />
      </div>
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
        <div className="flex items-center gap-2">
          <NewIssueButton
            orgId={orgId}
            projectId={projectId}
            projectKey={projectKey}
            boardId={boardId}
            onCreated={() => qc.invalidateQueries({ queryKey: itemsKey })}
          />
          <Button
            variant={tentativeOnly ? "default" : "outline"}
            size="xs"
            aria-pressed={tentativeOnly}
            onClick={() => {
              setTentativeOnly((v) => !v);
              setExpandedDay(null);
            }}
          >
            Tentative only
          </Button>
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
                  {dayItems.slice(0, 3).map((item) => {
                    // Tentative reads as a DASHED left edge — the same edge
                    // priority already colours, so the two stack instead of
                    // competing (the highlight owns the inset ring, see above).
                    const tentative = isTentative(item);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setDetailId(item.id)}
                        data-highlight={item.highlight ?? undefined}
                        data-tentative={tentative || undefined}
                        style={calendarHighlightStyle(item.highlight)}
                        className={cn(
                          "w-full text-left text-[10px] leading-tight px-1.5 py-0.5 rounded border-l-2 truncate bg-muted/40 hover:bg-muted",
                          priorityBorderMap[item.priority],
                          tentative && "border-dashed"
                        )}
                        title={[
                          `${projectKey}-${item.ticketNumber}: ${item.title}`,
                          tentative ? "Tentative" : null,
                          highlightLabel(item.highlight),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      >
                        {item.title}
                      </button>
                    );
                  })}
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
              {expandedDayItems.map((item) => {
                const state = commitState(item, intervals);
                return (
                  <div
                    key={item.id}
                    data-highlight={item.highlight ?? undefined}
                    style={calendarHighlightStyle(item.highlight)}
                    title={highlightLabel(item.highlight) ?? undefined}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md border p-2 border-l-4",
                      priorityBorderMap[item.priority],
                      state.kind !== "COMMITTED" && "border-dashed"
                    )}
                  >
                    {/* The row is no longer one big button: a Commit control
                        cannot be nested inside another button. The detail
                        target keeps the whole label area, as before. */}
                    <button
                      type="button"
                      onClick={() => setDetailId(item.id)}
                      className="flex flex-1 min-w-0 items-center gap-3 text-left rounded-sm hover:bg-muted/50"
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
                    </button>
                    <Badge className={cn("text-[10px] shrink-0", priorityColorMap[item.priority] === "bg-red-500" ? "bg-red-500/20 text-red-400" : priorityColorMap[item.priority] === "bg-orange-500" ? "bg-orange-500/20 text-orange-400" : priorityColorMap[item.priority] === "bg-blue-500" ? "bg-blue-500/20 text-blue-400" : "bg-muted text-muted-foreground")}>
                      {item.priority}
                    </Badge>
                    <CommitControl
                      state={state}
                      canCommit={canCommit}
                      intervalName={
                        state.kind === "COMMITTED"
                          ? intervalNames.get(state.intervalId) ?? null
                          : null
                      }
                      pending={commit.isPending && commit.variables?.item.id === item.id}
                      onCommit={(interval) => commit.mutate({ item, interval })}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <BoardItemDetailSheet
        itemId={detailId}
        onOpenChange={(open) => !open && setDetailId(null)}
        orgId={orgId}
        projectId={projectId}
        boardId={boardId}
      />
    </div>
  );
}

/**
 * The per-event Commit control, and the badge that replaces it once there is
 * nothing left to commit.
 *
 * Every branch renders SOMETHING, deliberately: "no button here" is the one
 * state a planner cannot act on or ask about. A tentative event with no PI
 * covering its dates shows a disabled Commit that says why, rather than
 * vanishing and leaving the row looking identical to a committed one.
 */
function CommitControl({
  state,
  canCommit,
  intervalName,
  pending,
  onCommit,
}: {
  state: CommitState;
  canCommit: boolean;
  /** Name of the interval a committed event sits in, when it is known. */
  intervalName: string | null;
  pending: boolean;
  onCommit: (interval: { id: string; name: string }) => void;
}) {
  if (state.kind === "COMMITTED") {
    // The interval's name when we have it, so the row says WHERE it went; the
    // bare word only when the item sits in an interval this board never loaded.
    return (
      <Badge className="text-[10px] shrink-0 bg-muted text-muted-foreground">
        {intervalName ? `Committed · ${intervalName}` : "Committed"}
      </Badge>
    );
  }

  if (state.kind === "UNSCHEDULED") return null;

  if (!canCommit) {
    return (
      <Badge className="text-[10px] shrink-0 bg-muted text-muted-foreground">Tentative</Badge>
    );
  }

  if (state.kind === "NO_PI") {
    return (
      <Button
        size="xs"
        variant="outline"
        disabled
        className="shrink-0"
        title={`No Program Increment covers ${state.day}`}
      >
        Commit
      </Button>
    );
  }

  return (
    <Button
      size="xs"
      variant="outline"
      disabled={pending}
      className="shrink-0"
      title={`Commit to ${state.interval.name}`}
      onClick={() => onCommit({ id: state.interval.id, name: state.interval.name })}
    >
      {pending ? "Committing…" : "Commit"}
    </Button>
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
