"use client";

import { useState, useEffect, useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "@/components/charts/lazy-recharts";
import { Skeleton } from "@/components/ui/skeleton";
import type { WorkItem, Board, BoardColumn } from "@/types/models";
import { cumulativeFlow, type CfdCategory } from "@/lib/dashboard/cfd";

interface CfdViewProps {
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

const categoryOrder = ["DONE", "IN_PROGRESS", "TODO", "CANCELLED"];

export function CfdView({ orgId, projectId, projectKey, boardId }: CfdViewProps) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [board, setBoard] = useState<Board | null>(null);
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      setError(null);

      try {
        const [boardRes, itemsRes] = await Promise.all([
          fetch(`${basePath}/boards/${boardId}`),
          fetch(`${basePath}/work-items`),
        ]);

        if (!boardRes.ok) throw new Error("Failed to load board");
        if (!itemsRes.ok) throw new Error("Failed to load work items");

        const boardData: Board = await boardRes.json();
        const itemsData: WorkItem[] = await itemsRes.json();

        if (cancelled) return;

        setBoard(boardData);
        setColumns(
          (boardData.columns ?? []).sort((a, b) => a.sortOrder - b.sortOrder)
        );
        setItems(itemsData);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unknown error");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchData();
    return () => { cancelled = true; };
  }, [orgId, projectId, boardId, basePath]);

  const columnCategoryMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of columns) {
      map.set(c.key, c.category);
    }
    return map;
  }, [columns]);

  // The last 30 days, approximated from createdAt / completedAt (this view has
  // no status history; dashboards' CFD panel feeds the same function real
  // transitions).
  const { cfdData, categories, hasHistory } = useMemo(() => {
    if (items.length === 0) {
      return { cfdData: [], categories: [], hasHistory: false };
    }
    const flow = cumulativeFlow({
      items,
      category: (key) => (columnCategoryMap.get(key) ?? "TODO") as CfdCategory,
      end: new Date(),
      days: 30,
    });
    const dates = items.map((i) => new Date(i.createdAt).getTime());
    const cats = categoryOrder.filter((c) => flow.categories.includes(c as CfdCategory));
    const data = flow.points.map((p) => {
      const entry: Record<string, string | number> = {
        date: new Date(`${p.date}T12:00:00Z`).toLocaleDateString("default", { month: "short", day: "numeric" }),
      };
      for (const cat of cats) entry[cat] = p.counts[cat as CfdCategory] ?? 0;
      return entry;
    });
    // More than a day between the oldest and newest item: there is a history to show.
    return { cfdData: data, categories: cats, hasHistory: Math.max(...dates) - Math.min(...dates) > 86400000 };
  }, [items, columnCategoryMap]);

  if (loading) return <CfdSkeleton />;

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

  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm text-muted-foreground">
          No work items to display. Add items to see the cumulative flow diagram.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b bg-background/50">
        <h2 className="text-sm font-semibold">Cumulative Flow Diagram</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          {hasHistory
            ? "Item distribution over the last 30 days"
            : "Current distribution shown (add items over time to see flow trends)"}
        </p>
      </div>

      <div className="flex-1 p-4 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={cfdData}
            stackOffset="none"
            margin={{ top: 8, right: 16, bottom: 0, left: -10 }}
          >
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "var(--text-muted)" }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 11, fill: "var(--text-muted)" }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--overlay)",
                border: "1px solid var(--border)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
            />
            <Legend
              verticalAlign="top"
              height={36}
              iconType="rect"
              iconSize={10}
              formatter={(value: string) => (
                <span style={{ color: "var(--text)", fontSize: "11px" }}>
                  {value.replace("_", " ")}
                </span>
              )}
            />
            {categories.map((cat) => (
              <Area
                key={cat}
                type="monotone"
                dataKey={cat}
                stackId="1"
                fill={categoryColorMap[cat] ?? "#6b7280"}
                stroke={categoryColorMap[cat] ?? "#6b7280"}
                fillOpacity={0.6}
                name={cat.replace("_", " ")}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function CfdSkeleton() {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-3 w-64 mt-2" />
      </div>
      <div className="flex-1 p-4">
        <Skeleton className="h-full w-full" />
      </div>
    </div>
  );
}
