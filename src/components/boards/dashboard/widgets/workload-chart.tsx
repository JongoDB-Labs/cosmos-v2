"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "@/components/charts/lazy-recharts";

interface WorkloadChartProps {
  data: Array<{ name: string; items: number }>;
  /** Drill-down: fired with the assignee's `name` when their bar is clicked. */
  onSliceClick?: (name: string) => void;
}

export function WorkloadChart({ data, onSliceClick }: WorkloadChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No assignee data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
      >
        <XAxis
          type="number"
          tick={{ fontSize: 11, fill: "var(--text-muted)" }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
        />
        <YAxis
          type="category"
          dataKey="name"
          tick={{ fontSize: 11, fill: "var(--text-muted)" }}
          axisLine={false}
          tickLine={false}
          width={100}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "var(--overlay)",
            border: "1px solid var(--border)",
            borderRadius: "8px",
            fontSize: "12px",
          }}
        />
        <Bar
          dataKey="items"
          fill="var(--status-discovery)"
          radius={[0, 4, 4, 0]}
          name="Items"
          onClick={onSliceClick ? (d: { name?: string }) => d?.name && onSliceClick(d.name) : undefined}
          className={onSliceClick ? "cursor-pointer" : undefined}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
