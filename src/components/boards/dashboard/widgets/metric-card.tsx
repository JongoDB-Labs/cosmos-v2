"use client";

import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

interface MetricCardProps {
  label: string;
  value: number;
  trend?: "up" | "down" | "flat";
  trendValue?: string;
  color?: string;
  /** When set, the card becomes a button that drills into its items. */
  onClick?: () => void;
}

export function MetricCard({ label, value, trend, trendValue, color, onClick }: MetricCardProps) {
  const interactive = !!onClick;
  return (
    <div
      className={cn(
        "flex flex-col gap-1",
        // Theme-aware hover: `bg-muted` maps to --surface (defined in both
        // light and dark). The previous `var(--muted, rgba(0,0,0,0.04))` fell
        // back to a hardcoded black tint on every theme (--muted is undefined),
        // so on the dark dashboard the metric cards had no visible hover state.
        interactive &&
          "cursor-pointer rounded-md p-1 -m-1 transition-colors hover:bg-muted/50",
      )}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={interactive ? (e) => (e.key === "Enter" || e.key === " ") && onClick!() : undefined}
    >
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
