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

  // Build CFD data: attempt to use createdAt and completedAt to simulate history
  const { cfdData, categories, hasHistory } = useMemo(() => {
    if (items.length === 0) {
      return { cfdData: [], categories: [], hasHistory: false };
    }

    // Get unique categories present
    const catSet = new Set<string>();
    for (const item of items) {
      const cat = columnCategoryMap.get(item.columnKey) ?? "TODO";
      catSet.add(cat);
    }
    const cats = categoryOrder.filter((c) => catSet.has(c));

    // Build 30-day historical data based on item createdAt and completedAt
    const now = new Date();
    const days = 30;
    const data: Array<Record<string, string | number>> = [];

    // Check if we have any date variation
    const dates = items.map((i) => new Date(i.createdAt).getTime());
    const minDate = Math.min(...dates);
    const maxDate = Math.max(...dates);
    const hasHistorical = maxDate - minDate > 86400000; // more than 1 day

    for (let d = days; d >= 0; d--) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      date.setHours(23, 59, 59, 999);

      const dateLabel = date.toLocaleDateString("default", {
        month: "short",
        day: "numeric",
      });

      // Count items that existed by this date, per category
      const counts: Record<string, number> = {};
      for (const cat of cats) {
        counts[cat] = 0;
      }

      for (const item of items) {
        const created = new Date(item.createdAt);
        if (created > date) continue; // item didn't exist yet

        // Determine what category the item was in on this date
        if (item.completedAt && new Date(item.completedAt) <= date) {
          counts["DONE"] = (counts["DONE"] ?? 0) + 1;
        } else {
          // Use current category as approximation
          const cat = columnCategoryMap.get(item.columnKey) ?? "TODO";
          if (cat === "DONE") {
            // Item is currently done but wasn't completed by this date
            counts["IN_PROGRESS"] = (counts["IN_PROGRESS"] ?? 0) + 1;
          } else {
            counts[cat] = (counts[cat] ?? 0) + 1;
          }
        }
      }

      const entry: Record<string, string | number> = { date: dateLabel };
      for (const cat of cats) {
        entry[cat] = counts[cat] ?? 0;
      }
      data.push(entry);
    }

    return { cfdData: data, categories: cats, hasHistory: hasHistorical };
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
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(var(--popover))",
                border: "1px solid hsl(var(--border))",
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
                <span style={{ color: "hsl(var(--foreground))", fontSize: "11px" }}>
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
