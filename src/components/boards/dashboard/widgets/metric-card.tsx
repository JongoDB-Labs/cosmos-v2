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
        {/* Addressable so a test can assert THIS metric moved, rather than
            matching a bare number that also appears in three other cards. */}
        <span
          data-testid={`metric-${label.toLowerCase().replace(/\s+/g, "-")}`}
          className={cn("text-2xl font-bold", color)}
        >
          {value}
        </span>
        {trend && (
          <span
            className={cn(
              "flex items-center gap-0.5 text-xs font-medium mb-1",
              // The `-text` tier, not the fill tier. At 12px this is normal
              // text and needs 4.5:1; `text-green-500` is 2.28:1 on white and
              // `text-red-500` is 3.76:1, so both fail — axe only ever
              // reported the red one because the fixture never renders an
              // "up" trend. globals.css carries a parallel `--status-*-text`
              // set for exactly this, and these flip per theme.
              trend === "up" && "text-[var(--status-done-text)]",
              trend === "down" && "text-[var(--status-critical-text)]",
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
