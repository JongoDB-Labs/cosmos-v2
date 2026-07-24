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
  const itemsKey = useOrgQueryKey("work-items", projectId);
  const membersKey = useOrgQueryKey("members");
  const intervalsKey = useOrgQueryKey("intervals", projectId);

  const [boardQ, itemsQ, membersQ, intervalsQ] = useQueries({
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
    ],
  });

  const board: Board | null = boardQ.data ?? null;
  const columns: BoardColumn[] = useMemo(
    () => (board?.columns ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder),
    [board],
  );
  const items: WorkItem[] = itemsQ.data ?? [];
  const members: OrgMember[] = membersQ.data ?? [];
  const intervals: Interval[] = intervalsQ.data ?? [];

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
    const total = items.length;
    const completed = items.filter((i) => {
      const cat = columnCategoryMap.get(i.columnKey);
      return cat === "DONE";
    }).length;
    const inProgress = items.filter((i) => {
      const cat = columnCategoryMap.get(i.columnKey);
      return cat === "IN_PROGRESS";
    }).length;
    const overdue = items.filter((i) => {
      if (!i.dueDate || i.completedAt) return false;
      return new Date(i.dueDate) < new Date();
    }).length;

    return { total, completed, inProgress, overdue };
  }, [items, columnCategoryMap]);

  // Status distribution
  const statusData = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of items) {
      const cat = columnCategoryMap.get(item.columnKey) ?? "TODO";
      counts[cat] = (counts[cat] ?? 0) + 1;
    }
    return Object.entries(counts).map(([name, value]) => ({
      name: name.replace("_", " "),
      value,
      color: categoryColorMap[name] ?? "#6b7280",
    }));
  }, [items, columnCategoryMap]);

  // Priority distribution
  const priorityData = useMemo(() => {
    const counts: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const item of items) {
      counts[item.priority] = (counts[item.priority] ?? 0) + 1;
    }
    return Object.entries(counts).map(([name, value]) => ({
      name: name.charAt(0) + name.slice(1).toLowerCase(),
      value,
      color: priorityColorMap[name] ?? "#6b7280",
    }));
  }, [items]);

  // Drill-down (FR 81918e0e): clicking a metric or chart segment opens a list
  // of the matching tickets, each deep-linking to its detail on the Issues page.
  const params = useParams();
  const orgSlug = typeof params?.orgSlug === "string" ? params.orgSlug : "";
  const [drill, setDrill] = useState<{ title: string; rows: WorkItem[] } | null>(null);
  const openDrill = (title: string, filter: (i: WorkItem) => boolean) =>
    setDrill({ title, rows: items.filter(filter) });
  const catOf = (i: WorkItem) => columnCategoryMap.get(i.columnKey) ?? "TODO";

  // Workload data (shares `assigneeLabel` with the drill-down below so the bar
  // a user clicks and the tickets it lists always describe the same bucket).
  const workloadData = useMemo(
    () => workloadBuckets(items, memberMap),
    [items, memberMap],
  );

  // Burndown data for active interval
  const burndownData = useMemo(() => {
    const activeInterval = intervals.find((s) => s.status === "ACTIVE");
    if (!activeInterval) return [];

    const intervalItems = items.filter((i) => i.intervalId === activeInterval.id);
    const totalPoints = intervalItems.reduce((sum, i) => sum + (i.storyPoints ?? 1), 0);
    // An active interval with no items has no burndown to draw — return empty so the
    // chart shows its "no data" state instead of a misleading flat zero line.
    if (totalPoints === 0) return [];

    const start = new Date(activeInterval.startDate);
    const end = new Date(activeInterval.endDate);
    const totalDays = Math.max(
      Math.ceil((end.getTime() - start.getTime()) / 86400000),
      1
    );

    const data: Array<{ date: string; ideal: number; actual: number }> = [];
    const today = new Date();

    for (let d = 0; d <= totalDays; d++) {
      const currentDate = new Date(start);
      currentDate.setDate(currentDate.getDate() + d);

      if (currentDate > today) break;

      const ideal = Math.round(totalPoints * (1 - d / totalDays));
      const completedByDate = intervalItems.filter(
        (i) => i.completedAt && new Date(i.completedAt) <= currentDate
      );
      const completedPoints = completedByDate.reduce(
        (sum, i) => sum + (i.storyPoints ?? 1),
        0
      );
      const actual = totalPoints - completedPoints;

      data.push({
        date: currentDate.toLocaleDateString("default", {
          month: "short",
          day: "numeric",
        }),
        ideal,
        actual,
      });
    }

    return data;
  }, [items, intervals]);

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
      body: <ActivityFeed items={items} projectKey={projectKey} />,
    },
  ];

  return (
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
