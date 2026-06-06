"use client";

import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

interface MetricCardProps {
  label: string;
  value: number;
  trend?: "up" | "down" | "flat";
  trendValue?: string;
  color?: string;
}

export function MetricCard({ label, value, trend, trendValue, color }: MetricCardProps) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-end gap-2">
        <span className={cn("text-2xl font-bold", color)}>{value}</span>
        {trend && (
          <span
            className={cn(
              "flex items-center gap-0.5 text-xs font-medium mb-1",
              trend === "up" && "text-green-500",
              trend === "down" && "text-red-500",
              trend === "flat" && "text-muted-foreground"
            )}
          >
            {trend === "up" && <TrendingUp className="h-3 w-3" />}
            {trend === "down" && <TrendingDown className="h-3 w-3" />}
            {trend === "flat" && <Minus className="h-3 w-3" />}
            {trendValue}
          </span>
        )}
      </div>
    </div>
  );
}
