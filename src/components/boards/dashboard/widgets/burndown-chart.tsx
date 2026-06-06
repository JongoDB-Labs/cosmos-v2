"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "@/components/charts/lazy-recharts";

interface BurndownChartProps {
  data: Array<{ date: string; ideal: number; actual: number }>;
}

export function BurndownChart({ data }: BurndownChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No active sprint data
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          axisLine={false}
          tickLine={false}
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
        <ReferenceLine y={0} stroke="hsl(var(--border))" />
        <Line
          type="monotone"
          dataKey="ideal"
          stroke="hsl(var(--muted-foreground))"
          strokeDasharray="5 5"
          strokeWidth={1.5}
          dot={false}
          name="Ideal"
        />
        <Line
          type="monotone"
          dataKey="actual"
          stroke="var(--status-progress)"
          strokeWidth={2}
          dot={{ fill: "var(--status-progress)", r: 3 }}
          activeDot={{ r: 5 }}
          name="Actual"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
