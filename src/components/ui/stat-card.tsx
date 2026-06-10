import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

interface StatCardProps {
  label: string;
  trend?: string; // e.g. "+12%", "-3", "flat"
  children: React.ReactNode;
  className?: string;
}

export function StatCard({ label, trend, children, className }: StatCardProps) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-soft)]",
        className,
      )}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)] md:text-[13px]">
          {label}
        </p>
        {trend && <TrendChip value={trend} />}
      </div>
      {children}
    </div>
  );
}

function TrendChip({ value }: { value: string }) {
  const direction =
    value.startsWith("+") ? "up" : value.startsWith("-") ? "down" : "flat";
  const Icon = direction === "up" ? TrendingUp : direction === "down" ? TrendingDown : Minus;
  // Label uses the AA-safe *-text token (theme-aware); the tint background keeps
  // the saturated base colour.
  const color =
    direction === "up"
      ? "var(--status-done-text, var(--status-done))"
      : direction === "down"
        ? "var(--status-critical-text, var(--status-critical))"
        : "var(--status-neutral-text, var(--text-muted))";
  const tint =
    direction === "up"
      ? "var(--status-done)"
      : direction === "down"
        ? "var(--status-critical)"
        : "var(--text-muted)";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{
        color,
        backgroundColor: `color-mix(in oklab, ${tint} 12%, transparent)`,
      }}
    >
      <Icon className="h-3 w-3" />
      {value}
    </span>
  );
}

function Number({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-3xl font-semibold tracking-tight text-[var(--text)]">
      {children}
    </p>
  );
}

function Bar({
  value,
  max,
  label,
}: {
  value: number;
  max: number;
  label?: string;
}) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="mt-3">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--primary-tint)]">
        <div
          className="h-full rounded-full bg-[var(--primary)]"
          style={{ width: `${pct}%` }}
        />
      </div>
      {label && (
        <p className="mt-1.5 text-xs text-[var(--text-muted)]">{label}</p>
      )}
    </div>
  );
}

function Sparkline({
  data,
  label,
}: {
  data: number[];
  label?: string;
}) {
  if (data.length === 0) return null;

  const width = 100;
  const height = 24;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = data.length > 1 ? width / (data.length - 1) : 0;

  const points = data
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div className="mt-3">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-6 w-full"
        aria-hidden
      >
        <polyline
          points={points}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      {label && (
        <p className="mt-1.5 text-xs text-[var(--text-muted)]">{label}</p>
      )}
    </div>
  );
}

StatCard.Number = Number;
StatCard.Bar = Bar;
StatCard.Sparkline = Sparkline;
