"use client";

import { useMemo, useState } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { TrendingDown } from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from "@/components/charts/lazy-recharts";
import { burndown, type BurndownUnit } from "@/lib/intervals/burndown";
import type { WorkItem, Interval, BoardColumn } from "@/types/models";

/**
 * Burndown / burnup for one interval.
 *
 * The Sprint Health board could say what the sprint looks like now and what past
 * sprints finished at, but nothing about the SHAPE of the sprint in flight —
 * which is the only one of the three a standup can act on.
 *
 * Everything honest about this chart is enforced in `@/lib/intervals/burndown`
 * and tested there; this file is presentation plus the two disclosures a reader
 * needs to judge whether to trust the line (reconstructed completion dates, and
 * estimate coverage when charting points).
 */

const NUMERIC_INTERVAL_KINDS = new Set(["SPRINT"]);

export function BurndownView({
  intervals,
  items,
  columns,
}: {
  intervals: Interval[];
  items: WorkItem[];
  columns: BoardColumn[];
}) {
  // Sprints only: a Program Increment spans months and its burndown is the PI
  // rollup's job, not this chart's.
  const sprints = useMemo(
    () =>
      intervals
        .filter((i) => NUMERIC_INTERVAL_KINDS.has(i.intervalKind ?? "SPRINT"))
        .slice()
        .sort((a, b) => b.number - a.number),
    [intervals],
  );

  // Default to the sprint in flight, because that is the question being asked.
  // Falling back to the newest keeps the chart useful between sprints instead of
  // showing an empty state that looks like a bug.
  const defaultId = useMemo(() => {
    const active = sprints.find((s) => s.status === "ACTIVE");
    return active?.id ?? sprints[0]?.id ?? null;
  }, [sprints]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [unit, setUnit] = useState<BurndownUnit>("count");

  const intervalId = selectedId ?? defaultId;
  const interval = sprints.find((s) => s.id === intervalId) ?? null;

  const doneKeys = useMemo(
    () => new Set(columns.filter((c) => c.category === "DONE").map((c) => c.key)),
    [columns],
  );

  const series = useMemo(() => {
    if (!interval) return null;
    const inInterval = items.filter((i) => i.intervalId === interval.id);
    return burndown({
      start: new Date(interval.startDate),
      end: new Date(interval.endDate),
      today: new Date(),
      unit,
      items: inInterval.map((i) => ({
        id: i.id,
        storyPoints: i.storyPoints ?? null,
        completedAt: i.completedAt ?? null,
        done: doneKeys.has(i.columnKey),
      })),
    });
  }, [interval, items, doneKeys, unit]);

  if (!interval) {
    return (
      <EmptyState
        icon={TrendingDown}
        title="No sprints to chart"
        description="A burndown needs a sprint with a start and end date. Create one on the Sprints page and it will appear here."
      />
    );
  }

  if (!series || series.points.length === 0) {
    return (
      <EmptyState
        icon={TrendingDown}
        title="This sprint has no usable date range"
        description="Its end date is before its start date, so there are no days to chart. Correct the dates on the Sprints page."
      />
    );
  }

  const empty = series.scope === 0;
  const pointsThin =
    unit === "points" &&
    series.pointsCoverage.total > 0 &&
    series.pointsCoverage.estimated < series.pointsCoverage.total;

  const chartData = series.points.map((p) => ({
    ...p,
    // Recharts renders a gap for null, which is exactly what a day with no data
    // should be — see the burndown module on why the future is not drawn.
    label: p.date.slice(5),
  }));

  const todayPoint = series.points.find((p) => p.isToday);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-[var(--text-muted)]" htmlFor="burndown-sprint">
            Sprint
          </label>
          <select
            id="burndown-sprint"
            aria-label="Sprint to chart"
            value={interval.id}
            onChange={(e) => setSelectedId(e.target.value)}
            className="rounded-[calc(var(--radius)-2px)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
          >
            {sprints.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.status === "ACTIVE" ? " (active)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div role="group" aria-label="Burndown unit" className="flex gap-0.5">
          {(["count", "points"] as const).map((u) => (
            <button
              key={u}
              type="button"
              aria-pressed={unit === u}
              onClick={() => setUnit(u)}
              className={
                unit === u
                  ? "rounded-[calc(var(--radius)-2px)] bg-[var(--primary)] px-2.5 py-1 text-xs font-medium text-[var(--primary-foreground,#fff)]"
                  : "rounded-[calc(var(--radius)-2px)] px-2.5 py-1 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
              }
            >
              {u === "count" ? "Items" : "Story points"}
            </button>
          ))}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Scope" value={series.scope} />
        <Stat label="Completed" value={series.completed} />
        <Stat label="Remaining" value={series.remaining} />
        <Stat label="Working days" value={series.workingDays} />
      </dl>

      {empty ? (
        <EmptyState
          icon={TrendingDown}
          title="Nothing is in this sprint yet"
          description="A burndown needs work assigned to the sprint. Add items to it on the Backlog or Sprint board and the chart will fill in."
        />
      ) : (
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--text-muted)" />
              <YAxis tick={{ fontSize: 11 }} stroke="var(--text-muted)" allowDecimals={false} />
              <Tooltip
                contentStyle={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {todayPoint && (
                <ReferenceLine x={todayPoint.date.slice(5)} stroke="var(--text-muted)" strokeDasharray="2 2" />
              )}
              <Line
                type="monotone"
                dataKey="ideal"
                name="Ideal"
                stroke="var(--text-muted)"
                strokeDasharray="4 4"
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="remaining"
                name="Remaining"
                stroke="var(--primary)"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="completed"
                name="Completed"
                stroke="#16a34a"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* The two disclosures that decide whether the line above can be trusted. */}
      {series.undatedCompletions > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          {series.undatedCompletions} completed{" "}
          {series.undatedCompletions === 1 ? "item has" : "items have"} no recorded completion date,
          so {series.undatedCompletions === 1 ? "it is" : "they are"} counted today rather than on
          the day the work finished. Earlier days therefore understate progress.
        </p>
      )}
      {pointsThin && (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          Only {series.pointsCoverage.estimated} of {series.pointsCoverage.total} items carry an
          estimate. Unestimated items count as zero here, so the points view understates the sprint —
          the Items view counts every one.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
      <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
