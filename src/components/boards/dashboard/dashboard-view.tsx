"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQueries } from "@tanstack/react-query";
import { GridLayout, verticalCompactor } from "react-grid-layout";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MetricCard } from "./widgets/metric-card";
import { StatusChart } from "./widgets/status-chart";
import { PriorityChart } from "./widgets/priority-chart";
import { BurndownChart } from "./widgets/burndown-chart";
import { WorkloadChart } from "./widgets/workload-chart";
import { ActivityFeed } from "./widgets/activity-feed";
import { SprintTrendView, PiRollupView } from "./sprint-history";
import { BurndownView } from "./burndown-view";
import {
  CycleTimePanel,
  ThroughputPanel,
  WorkTypeMixPanel,
  ScopeChangePanel,
  toDeliveryItems,
} from "./delivery-panels";
import type { IntervalChange } from "@/lib/dashboard/scope-change";
import { FilterBar, emptyFilters, type BoardFilters } from "@/components/boards/shared/filter-bar";
import { matchesFilters } from "@/lib/work-items/board-filters";
import { burndown } from "@/lib/intervals/burndown";
import { defaultCeremonyInterval } from "@/lib/intervals/ceremony-intervals";
import { cn } from "@/lib/utils";
import { assigneeLabel, workloadBuckets } from "./workload";
import type { WorkItem, Board, BoardColumn, OrgMember, Interval } from "@/types/models";

import "react-grid-layout/css/styles.css";

interface DashboardViewProps {
  orgId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
}

const categoryColorMap: Record<string, string> = {
  TODO: "#6b7280",
  IN_PROGRESS: "#3b82f6",
  DONE: "#22c55e",
  CANCELLED: "#ef4444",
};

const priorityColorMap: Record<string, string> = {
  CRITICAL: "#ef4444",
  HIGH: "#f97316",
  MEDIUM: "#3b82f6",
  LOW: "#6b7280",
};

const DEFAULT_LAYOUTS = {
  lg: [
    { i: "metrics", x: 0, y: 0, w: 12, h: 3 },
    { i: "status", x: 0, y: 3, w: 4, h: 7 },
    { i: "priority", x: 4, y: 3, w: 4, h: 7 },
    { i: "workload", x: 8, y: 3, w: 4, h: 7 },
    { i: "burndown", x: 0, y: 10, w: 6, h: 7 },
    { i: "activity", x: 6, y: 10, w: 6, h: 7 },
  ],
  md: [
    { i: "metrics", x: 0, y: 0, w: 10, h: 3 },
    { i: "status", x: 0, y: 3, w: 5, h: 7 },
    { i: "priority", x: 5, y: 3, w: 5, h: 7 },
    { i: "workload", x: 0, y: 10, w: 5, h: 7 },
    { i: "burndown", x: 5, y: 10, w: 5, h: 7 },
    { i: "activity", x: 0, y: 17, w: 10, h: 7 },
  ],
  sm: [
    { i: "metrics", x: 0, y: 0, w: 6, h: 4 },
    { i: "status", x: 0, y: 4, w: 6, h: 7 },
    { i: "priority", x: 0, y: 11, w: 6, h: 7 },
    { i: "workload", x: 0, y: 18, w: 6, h: 7 },
    { i: "burndown", x: 0, y: 25, w: 6, h: 7 },
    { i: "activity", x: 0, y: 32, w: 6, h: 7 },
  ],
};

export function DashboardView({ orgId, projectId, projectKey, boardId }: DashboardViewProps) {
  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  const boardKey = useOrgQueryKey("board", boardId);
  // Sprint Health answered only "how is the sprint in flight?". These add the
  // two questions a team asks between ceremonies. Current stays the default so
  // the board opens exactly as it did.
  const [healthView, setHealthView] = useState<"current" | "burndown" | "across">("current");
  // "Trend across sprints" and "PI rollup" were two tabs asking the same
  // question at two altitudes, so a reader wanting both had to remember which
  // tab held which. One tab, one toggle: the SCOPE is the variable, not the
  // destination. Sprint is the default because that is the cadence a team
  // actually runs on; the increment view is the one you go looking for.
  const [timeScope, setTimeScope] = useState<"sprint" | "pi">("sprint");

  // Sprint Health was the only board family with no filtering at all — every
  // number on it described the whole project, so a lead could not ask "how is MY
  // team doing?" without leaving the page. This uses the SHARED predicate and
  // the SHARED control (see lib/work-items/board-filters.ts); a dashboard that
  // filtered differently from the boards it summarises would be worse than one
  // that does not filter.
  const [filters, setFilters] = useState<BoardFilters>(emptyFilters);

  const itemsKey = useOrgQueryKey("work-items", projectId);
  const changesKey = useOrgQueryKey("interval-changes", projectId);
  const membersKey = useOrgQueryKey("members");
  const intervalsKey = useOrgQueryKey("intervals", projectId);

  const [boardQ, itemsQ, membersQ, intervalsQ, changesQ] = useQueries({
    queries: [
      {
        queryKey: boardKey,
        queryFn: () => jsonFetch<Board>(`${basePath}/boards/${boardId}`),
      },
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
      {
        // Scope churn is the one panel that cannot be derived from the items
        // themselves — an item that LEFT a sprint is not in that sprint any
        // more, so only the activity history remembers it happened.
        queryKey: changesKey,
        queryFn: () =>
          jsonFetch<{ changes: IntervalChange[]; truncated: boolean }>(
            `${basePath}/interval-changes`,
          ),
      },
    ],
  });

  const board: Board | null = boardQ.data ?? null;
  const columns: BoardColumn[] = useMemo(
    () => (board?.columns ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder),
    [board],
  );
  // Memoised because `?? []` mints a NEW array on every render, which would make
  // every downstream useMemo — filtering, metrics, burndown — recompute each
  // time regardless of whether the data changed.
  const items: WorkItem[] = useMemo(() => itemsQ.data ?? [], [itemsQ.data]);
  const members: OrgMember[] = useMemo(() => membersQ.data ?? [], [membersQ.data]);
  const intervals: Interval[] = useMemo(() => intervalsQ.data ?? [], [intervalsQ.data]);

  const loading =
    boardQ.isLoading ||
    itemsQ.isLoading ||
    membersQ.isLoading ||
    intervalsQ.isLoading;

  const fatalError = boardQ.error || itemsQ.error;
  const error = fatalError
    ? fatalError instanceof Error
      ? fatalError.message
      : "Unknown error"
    : null;

  // One instant for the whole pass, so a due-date filter cannot classify two
  // items differently because the clock ticked between them.
  const filteredItems = useMemo(() => {
    const now = new Date();
    return items.filter((i) => matchesFilters(i, filters, [], new Map(), now));
  }, [items, filters]);

  const columnCategoryMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of columns) {
      map.set(c.key, c.category);
    }
    return map;
  }, [columns]);

  const memberMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      map.set(m.userId, m.user?.displayName ?? m.user?.email ?? "Unknown");
    }
    return map;
  }, [members]);

  // Compute metrics
  const metrics = useMemo(() => {
    const total = filteredItems.length;
    const completed = filteredItems.filter((i) => {
      const cat = columnCategoryMap.get(i.columnKey);
      return cat === "DONE";
    }).length;
    const inProgress = filteredItems.filter((i) => {
      const cat = columnCategoryMap.get(i.columnKey);
      return cat === "IN_PROGRESS";
    }).length;
    const overdue = filteredItems.filter((i) => {
      if (!i.dueDate || i.completedAt) return false;
      return new Date(i.dueDate) < new Date();
    }).length;

    return { total, completed, inProgress, overdue };
  }, [filteredItems, columnCategoryMap]);

  // Status distribution
  const statusData = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of filteredItems) {
      const cat = columnCategoryMap.get(item.columnKey) ?? "TODO";
      counts[cat] = (counts[cat] ?? 0) + 1;
    }
    return Object.entries(counts).map(([name, value]) => ({
      name: name.replace("_", " "),
      value,
      color: categoryColorMap[name] ?? "#6b7280",
    }));
  }, [filteredItems, columnCategoryMap]);

  // Priority distribution
  const priorityData = useMemo(() => {
    const counts: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const item of filteredItems) {
      counts[item.priority] = (counts[item.priority] ?? 0) + 1;
    }
    return Object.entries(counts).map(([name, value]) => ({
      name: name.charAt(0) + name.slice(1).toLowerCase(),
      value,
      color: priorityColorMap[name] ?? "#6b7280",
    }));
  }, [filteredItems]);

  // Drill-down (FR 81918e0e): clicking a metric or chart segment opens a list
  // of the matching tickets, each deep-linking to its detail on the Issues page.
  const params = useParams();
  const orgSlug = typeof params?.orgSlug === "string" ? params.orgSlug : "";
  const [drill, setDrill] = useState<{ title: string; rows: WorkItem[] } | null>(null);
  const openDrill = (title: string, filter: (i: WorkItem) => boolean) =>
    setDrill({ title, rows: filteredItems.filter(filter) });
  const catOf = (i: WorkItem) => columnCategoryMap.get(i.columnKey) ?? "TODO";

  // Workload data (shares `assigneeLabel` with the drill-down below so the bar
  // a user clicks and the tickets it lists always describe the same bucket).
  const workloadData = useMemo(
    () => workloadBuckets(filteredItems, memberMap),
    [filteredItems, memberMap],
  );

  // Burndown for the active interval, via the SHARED computation.
  //
  // This was computed inline here, and got four things wrong that the module
  // fixes: it summed `storyPoints ?? 1`, mixing points and item counts into a
  // unit that is neither; it burned the ideal line down across weekends; it
  // compared completion timestamps against a date still carrying the sprint
  // start's time-of-day, so a day boundary landed mid-afternoon; and it trusted
  // `completedAt` alone, so an item reopened after completion stayed burned
  // down. One implementation, tested once — see lib/intervals/burndown.ts.
  const burndownData = useMemo(() => {
    // NOT `.find(s => s.status === "ACTIVE")`. A Program Increment is ACTIVE for
    // as long as any sprint inside it runs, and the API orders by number DESC
    // with a PI numbered above its sprints — so that find returns the PI, which
    // holds no work items of its own, and the widget renders "no active sprint
    // data" while a sprint is plainly running. Same picker as the ceremony
    // boards, which already solved this.
    const activeInterval = defaultCeremonyInterval(intervals);
    if (!activeInterval) return [];

    const series = burndown({
      start: new Date(activeInterval.startDate),
      end: new Date(activeInterval.endDate),
      today: new Date(),
      unit: "count",
      items: filteredItems
        .filter((i) => i.intervalId === activeInterval.id)
        .map((i) => ({
          id: i.id,
          storyPoints: i.storyPoints ?? null,
          completedAt: i.completedAt ?? null,
          done: columnCategoryMap.get(i.columnKey) === "DONE",
        })),
    });

    // An interval with nothing in it has no burndown to draw — empty so the
    // widget shows its "no data" state rather than a misleading flat zero line.
    if (series.scope === 0) return [];

    // The widget draws only observed days; the module returns nulls past today
    // precisely so no caller can accidentally chart the future.
    return series.points
      .filter((p) => !p.isFuture)
      .map((p) => ({
        date: new Date(`${p.date}T00:00:00`).toLocaleDateString("default", {
          month: "short",
          day: "numeric",
        }),
        ideal: Math.round(p.ideal),
        actual: p.remaining ?? 0,
      }));
  }, [filteredItems, intervals, columnCategoryMap]);

  // One adaptation of the filtered set, shared by all three delivery panels, so
  // "done" and "type" cannot come to mean different things on the same screen.
  const deliveryItems = useMemo(
    () => toDeliveryItems(filteredItems, columns),
    [filteredItems, columns],
  );

  if (loading) return <DashboardSkeleton />;

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

  // Define each widget once; reused by both the desktop GridLayout and the
  // mobile vertical stack so we don't duplicate rendering logic.
  const widgetDefs: Array<{
    key: string;
    title: string;
    body: React.ReactNode;
  }> = [
    {
      key: "metrics",
      title: "Overview",
      body: (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard
            label="Total Items"
            value={metrics.total}
            onClick={() => openDrill("All items", () => true)}
          />
          <MetricCard
            label="Completed"
            value={metrics.completed}
            color="text-green-500"
            onClick={() => openDrill("Completed", (i) => catOf(i) === "DONE")}
          />
          <MetricCard
            label="In Progress"
            value={metrics.inProgress}
            color="text-blue-500"
            onClick={() => openDrill("In Progress", (i) => catOf(i) === "IN_PROGRESS")}
          />
          <MetricCard
            label="Overdue"
            value={metrics.overdue}
            color="text-red-500"
            trend={metrics.overdue > 0 ? "down" : "flat"}
            trendValue={metrics.overdue > 0 ? "Action needed" : "On track"}
            onClick={() =>
              openDrill(
                "Overdue",
                (i) => !!i.dueDate && !i.completedAt && new Date(i.dueDate) < new Date(),
              )
            }
          />
        </div>
      ),
    },
    {
      key: "status",
      title: "Status Distribution",
      body: (
        <StatusChart
          data={statusData}
          onSliceClick={(name) =>
            openDrill(name, (i) => catOf(i).replace("_", " ") === name)
          }
        />
      ),
    },
    {
      key: "priority",
      title: "Priority Distribution",
      body: (
        <PriorityChart
          data={priorityData}
          onSliceClick={(name) =>
            openDrill(`${name} priority`, (i) => i.priority === name.toUpperCase())
          }
        />
      ),
    },
    {
      key: "workload",
      title: "Assignee Workload",
      body: (
        <WorkloadChart
          data={workloadData}
          onSliceClick={(name) =>
            openDrill(name, (i) => assigneeLabel(i, memberMap) === name)
          }
        />
      ),
    },
    {
      key: "burndown",
      title: "Interval Burndown",
      body: <BurndownChart data={burndownData} />,
    },
    {
      key: "activity",
      title: "Recent Activity",
      body: <ActivityFeed items={filteredItems} projectKey={projectKey} />,
    },
    {
      // Status and priority say where the work STANDS; neither says what kind of
      // work it is. A sprint that is 60% defects and one that is 60% features
      // are indistinguishable on this board without it, and they call for
      // opposite conversations.
      key: "worktype",
      title: "Work Type Mix",
      // `bare`: the grid cell already draws the border and the heading.
      body: <WorkTypeMixPanel items={deliveryItems} bare />,
    },
  ];

  const HEALTH_VIEWS = [
    { key: "current" as const, label: "Current sprint" },
    { key: "burndown" as const, label: "Burndown" },
    { key: "across" as const, label: "Across time" },
  ];

  const TIME_SCOPES = [
    { key: "sprint" as const, label: "By sprint" },
    { key: "pi" as const, label: "By increment" },
  ];

  return (
    <>
      <div
        role="tablist"
        aria-label="Sprint health view"
        className="flex flex-wrap gap-0.5 border-b border-[var(--border)] px-3 py-2"
      >
        {HEALTH_VIEWS.map((v) => (
          <button
            key={v.key}
            role="tab"
            aria-selected={healthView === v.key}
            onClick={() => setHealthView(v.key)}
            className={cn(
              "rounded-[calc(var(--radius)-2px)] px-3 py-1.5 text-sm font-medium transition-colors",
              healthView === v.key
                ? "bg-[var(--primary)] text-[var(--primary-foreground,#fff)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]",
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* Filters apply to EVERY view, including the ones that read intervals —
          the burndown charts filtered items, so "my team's burndown" is the same
          question asked once. */}
      <div className="border-b border-[var(--border)] px-3 py-2">
        <FilterBar
          filters={filters}
          onFilterChange={setFilters}
          members={members}
          intervals={intervals}
          orgId={orgId}
          boardColumns={columns.map((c) => ({ key: c.key, name: c.name }))}
        />
      </div>

      {healthView !== "current" ? (
        <div className="flex-1 overflow-auto p-4">
          {healthView === "burndown" ? (
            <BurndownView intervals={intervals} items={filteredItems} columns={columns} />
          ) : (
            <div className="space-y-4">
              {/* The scope toggle. Rendered as a real tablist rather than a
                  select: it is two options a reader flips between constantly,
                  and burying that in a dropdown costs a click every time. */}
              <div
                role="tablist"
                aria-label="Time scope"
                className="inline-flex gap-0.5 rounded-[var(--radius)] border border-[var(--border)] p-0.5"
              >
                {TIME_SCOPES.map((s) => (
                  <button
                    key={s.key}
                    role="tab"
                    aria-selected={timeScope === s.key}
                    onClick={() => setTimeScope(s.key)}
                    className={cn(
                      "rounded-[calc(var(--radius)-3px)] px-3 py-1 text-xs font-medium transition-colors",
                      timeScope === s.key
                        ? "bg-[var(--primary)] text-[var(--primary-foreground,#fff)]"
                        : "text-[var(--text-muted)] hover:text-[var(--text)]",
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>

              {timeScope === "sprint" ? (
                <div className="space-y-4">
                  <div className="grid gap-4 lg:grid-cols-2">
                    <ThroughputPanel items={deliveryItems} intervals={intervals} />
                    <CycleTimePanel items={deliveryItems} />
                    <ScopeChangePanel
                      items={deliveryItems}
                      intervals={intervals}
                      changes={changesQ.data?.changes ?? []}
                      truncated={changesQ.data?.truncated}
                      loading={changesQ.isLoading}
                    />
                  </div>
                  <SprintTrendView intervals={intervals} />
                </div>
              ) : (
                /* Increment scope deliberately does NOT re-render the sprint
                   panels against PIs. A Program Increment holds no work items of
                   its own, so a throughput bar for one reads zero and a cycle
                   time over one is empty — the panels would render, and lie. */
                <PiRollupView intervals={intervals} />
              )}
            </div>
          )}
        </div>
      ) : (
      <>
      {/* Mobile: vertical stack of widget cards. Drag/resize is mouse-only,
          so at <md we render a read-only stack via CSS — no hydration flash. */}
      <div className="md:hidden flex-1 overflow-auto p-3">
        <div className="space-y-3">
          {widgetDefs.map((w) => (
            <div
              key={w.key}
              className="rounded-lg border bg-background p-4"
            >
              <h3 className="text-xs font-medium text-muted-foreground mb-3">
                {w.title}
              </h3>
              <div className={w.key === "metrics" ? "" : "h-56"}>{w.body}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Desktop: react-grid-layout. Hidden via CSS below md. */}
      <div className="hidden md:block flex-1 overflow-auto p-4">
        <GridLayout
          layout={DEFAULT_LAYOUTS.lg}
          gridConfig={{ cols: 12, rowHeight: 30, margin: [12, 12] as [number, number] }}
          width={1200}
          compactor={verticalCompactor}
        >
          {widgetDefs.map((w) => (
            <div
              key={w.key}
              className="rounded-lg border bg-background p-4 flex flex-col"
            >
              <h3 className="text-xs font-medium text-muted-foreground mb-2">
                {w.title}
              </h3>
              <div
                className={
                  w.key === "metrics"
                    ? ""
                    : w.key === "activity"
                    ? "flex-1 min-h-0 overflow-hidden"
                    : "flex-1 min-h-0"
                }
              >
                {w.body}
              </div>
            </div>
          ))}
        </GridLayout>
      </div>
      </>
      )}

      {/* Drill-down: the tickets behind a clicked metric / chart segment. */}
      <Dialog open={drill !== null} onOpenChange={(o) => !o && setDrill(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {drill?.title} · {drill?.rows.length ?? 0} item{drill?.rows.length === 1 ? "" : "s"}
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-96 divide-y overflow-y-auto rounded-md border">
            {drill && drill.rows.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">No matching items.</p>
            ) : (
              drill?.rows.map((i) => (
                <Link
                  key={i.id}
                  href={`/${orgSlug}/issues?item=${i.id}`}
                  className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/50"
                  onClick={() => setDrill(null)}
                >
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {projectKey}-{i.ticketNumber}
                  </span>
                  <span className="flex-1 truncate">{i.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {(columnCategoryMap.get(i.columnKey) ?? "TODO").replace("_", " ").toLowerCase()}
                  </span>
                </Link>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex-1 p-4 space-y-3">
      <Skeleton className="h-24 w-full rounded-lg" />
      <div className="grid grid-cols-3 gap-3">
        <Skeleton className="h-52 rounded-lg" />
        <Skeleton className="h-52 rounded-lg" />
        <Skeleton className="h-52 rounded-lg" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-52 rounded-lg" />
        <Skeleton className="h-52 rounded-lg" />
      </div>
    </div>
  );
}
