"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "@/components/charts/lazy-recharts";
import {
  cycleTime,
  throughput,
  throughputSummary,
  workTypeMix,
  type DeliveryItemLike,
  type ThroughputInterval,
} from "@/lib/dashboard/delivery-metrics";
import { ceremonySelectableIntervals } from "@/lib/intervals/ceremony-intervals";
import type { WorkItem, Interval, BoardColumn } from "@/types/models";

/**
 * The three Jira-parity panels Sprint Health was missing: cycle time, throughput
 * and work-type mix.
 *
 * Everything honest about these numbers is enforced and tested in
 * `@/lib/dashboard/delivery-metrics`. This file is presentation plus the
 * DISCLOSURES — the coverage line under each figure. Those are not decoration:
 * a median cycle time drawn from a fifth of the finished work looks exactly like
 * one drawn from all of it, and the only difference a reader can act on is the
 * sentence saying which they are looking at.
 */

/** Shared adapter, so all three panels agree on what "done" and "type" mean. */
export function toDeliveryItems(
  items: WorkItem[],
  columns: BoardColumn[],
): DeliveryItemLike[] {
  const categoryByKey = new Map(columns.map((c) => [c.key, c.category]));
  return items.map((i) => ({
    id: i.id,
    intervalId: i.intervalId,
    storyPoints: i.storyPoints,
    actualStart: i.actualStart,
    completedAt: i.completedAt,
    done: categoryByKey.get(i.columnKey) === "DONE",
    // The type is `include`d by the list route, but a board rendered from a
    // narrower payload must still chart: an unlabelled bucket is better than a
    // crash, and better than silently dropping the item out of the mix.
    typeKey: i.workItemType?.key ?? "unknown",
    typeName: i.workItemType?.name ?? "Unspecified",
    typeColor: i.workItemType?.color ?? null,
    workCategory: i.workCategory,
  }));
}

const CHART_TOOLTIP = {
  backgroundColor: "var(--overlay)",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  fontSize: "12px",
} as const;

/**
 * `bare` drops the card and title, for the one caller that already supplies
 * them: the Current-sprint grid renders each widget inside its own bordered,
 * titled cell, so a self-titling panel there shows the heading and the border
 * twice. The question line and the footnote survive in both modes — those are
 * the panel's meaning, not its decoration.
 */
function PanelShell({
  title,
  question,
  children,
  footnote,
  bare,
}: {
  title: string;
  /** The question this panel exists to answer — shown, not just documented. */
  question: string;
  children: React.ReactNode;
  footnote?: React.ReactNode;
  bare?: boolean;
}) {
  const inner = (
    <>
      {bare ? (
        <p className="text-xs text-[var(--text-muted)] mb-2">{question}</p>
      ) : (
        <header className="mb-3">
          <h3 className="text-sm font-medium text-[var(--text)]">{title}</h3>
          <p className="text-xs text-[var(--text-muted)]">{question}</p>
        </header>
      )}
      <div className="flex-1 min-h-0">{children}</div>
      {footnote ? (
        <p className="mt-3 pt-2 border-t border-[var(--border)] text-[11px] text-[var(--text-muted)]">
          {footnote}
        </p>
      ) : null}
    </>
  );

  if (bare) return <div className="flex flex-col h-full">{inner}</div>;
  return (
    <section className="rounded-lg border border-[var(--border)] bg-background p-4 flex flex-col">
      {inner}
    </section>
  );
}

function NotEnoughData({ what }: { what: string }) {
  // Deliberately says WHAT is missing rather than "No data". A reader who is
  // told "no data" concludes the feature is broken; one told "no item in this
  // filter has a recorded start" knows what to do about it.
  return (
    <div className="flex items-center justify-center h-full min-h-[8rem] text-center">
      <p className="text-xs text-[var(--text-muted)] max-w-xs">{what}</p>
    </div>
  );
}

/** Days rendered the way a human says them: hours below a day, one decimal below ten. */
function formatDays(days: number | null): string {
  if (days === null) return "—";
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  if (days < 10) return `${days.toFixed(1)}d`;
  return `${Math.round(days)}d`;
}

// ---------------------------------------------------------------------------

export function CycleTimePanel({ items }: { items: DeliveryItemLike[] }) {
  const result = useMemo(() => cycleTime(items), [items]);
  const { coverage } = result;

  if (result.days.length === 0) {
    return (
      <PanelShell
        title="Cycle time"
        question="Once we start something, how long until it is done?"
      >
        <NotEnoughData
          what={
            coverage.done === 0
              ? "Nothing here has finished yet, so there is no cycle time to measure."
              : `${coverage.done} finished ${coverage.done === 1 ? "item" : "items"}, none carrying both a start and a completion time. Cycle time is measured from when work actually began — items move in-progress to record it.`
          }
        />
      </PanelShell>
    );
  }

  const pct = Math.round((coverage.measured / Math.max(1, coverage.done)) * 100);

  return (
    <PanelShell
      title="Cycle time"
      question="Once we start something, how long until it is done?"
      footnote={
        <>
          Measured over {coverage.measured} of {coverage.done} finished{" "}
          {coverage.done === 1 ? "item" : "items"} ({pct}%) — only work with a
          recorded start can be timed.
          {result.anomalies > 0 ? (
            <>
              {" "}
              <span className="text-[var(--warning,#f97316)]">
                {result.anomalies} excluded for finishing before they started.
              </span>
            </>
          ) : null}
        </>
      }
    >
      <div className="grid grid-cols-3 gap-2 mb-3">
        <Stat label="Median" value={formatDays(result.median)} testId="cycle-median" />
        <Stat
          label="85th pct"
          value={formatDays(result.p85)}
          hint="most work lands inside this"
          testId="cycle-p85"
        />
        <Stat label="Mean" value={formatDays(result.mean)} testId="cycle-mean" />
      </div>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={result.histogram} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: "var(--text-muted)" }} interval={0} />
            <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} allowDecimals={false} />
            <Tooltip
              contentStyle={CHART_TOOLTIP}
              formatter={(v) => [`${Number(v)} items`, "Count"]}
            />
            <Bar dataKey="count" fill="var(--primary)" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------------

export function ThroughputPanel({
  items,
  intervals,
}: {
  items: DeliveryItemLike[];
  intervals: Interval[];
}) {
  // Iterations only, and by EXCLUDING the container rather than allowlisting
  // SPRINT — a Program Increment holds no work items of its own, so charting it
  // draws a zero bar next to real sprints and reads as a failed increment.
  const sprints: ThroughputInterval[] = useMemo(
    () =>
      ceremonySelectableIntervals(intervals).map((i) => ({
        id: i.id,
        name: i.name,
        status: i.status,
        startDate: i.startDate,
        endDate: i.endDate,
      })),
    [intervals],
  );

  const series = useMemo(() => throughput(items, sprints), [items, sprints]);
  const summary = useMemo(() => throughputSummary(series), [series]);

  if (series.length === 0) {
    return (
      <PanelShell title="Throughput" question="How many items are we finishing per sprint?">
        <NotEnoughData what="This project has no sprints yet, so there is nothing to compare across." />
      </PanelShell>
    );
  }

  return (
    <PanelShell
      title="Throughput"
      question="How many items are we finishing per sprint?"
      footnote={
        summary.closed === 0 ? (
          "No sprint has closed yet — the average appears once one has."
        ) : (
          <>
            Average {summary.mean!.toFixed(1)} items across {summary.closed} closed{" "}
            {summary.closed === 1 ? "sprint" : "sprints"}
            {summary.variability !== null ? (
              <>
                {" "}
                (±{Math.round(summary.variability * 100)}% variation)
              </>
            ) : null}
            . A sprint still running is drawn faded — it is partway through, not down.
          </>
        )
      }
    >
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={series} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: "var(--text-muted)" }} />
            <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} allowDecimals={false} />
            <Tooltip
              contentStyle={CHART_TOOLTIP}
              formatter={(v, _name, entry) => {
                // Total and in-flight come off the datum, so the tooltip says
                // "3 of 11 finished (in flight)" rather than a bare 3 that reads
                // as the sprint's final result.
                const point = (entry as { payload?: { total?: number; isPartial?: boolean } })?.payload;
                const done = Number(v);
                const suffix = point?.isPartial ? " (in flight)" : "";
                return [`${done} of ${point?.total ?? done} finished${suffix}`, "Completed"];
              }}
            />
            <Bar dataKey="count" radius={[3, 3, 0, 0]}>
              {series.map((p) => (
                // The running sprint is faded, never hidden and never styled the
                // same as a closed one: a partial bar read as a final result is
                // how a healthy team looks like it collapsed.
                <Cell
                  key={p.intervalId}
                  fill="var(--primary)"
                  fillOpacity={p.isPartial ? 0.35 : 1}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------------

export function WorkTypeMixPanel({
  items,
  bare,
}: {
  items: DeliveryItemLike[];
  bare?: boolean;
}) {
  const mix = useMemo(() => workTypeMix(items), [items]);

  if (mix.total === 0) {
    return (
      <PanelShell
        title="Work type mix"
        question="How much of our capacity goes to features versus debt and defects?"
        bare={bare}
      >
        <NotEnoughData what="No items match the current filters." />
      </PanelShell>
    );
  }

  const business = mix.byCategory.find((c) => c.category === "BUSINESS")!;
  const enabler = mix.byCategory.find((c) => c.category === "ENABLER")!;
  const businessPct = Math.round((business.count / mix.total) * 100);

  return (
    <PanelShell
      title="Work type mix"
      question="How much of our capacity goes to features versus debt and defects?"
      bare={bare}
      footnote={
        <>
          {business.count} business · {enabler.count} enabler ({businessPct}% /{" "}
          {100 - businessPct}%).{" "}
          {mix.estimated < mix.total
            ? `${mix.estimated} of ${mix.total} items are estimated, so counts are the reliable measure here.`
            : "Every item is estimated."}
        </>
      }
    >
      <ul className="space-y-2">
        {mix.byType.map((t) => {
          const pct = Math.round((t.count / mix.total) * 100);
          return (
            <li key={t.key} data-testid={`work-type-${t.key}`}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-[var(--text)] truncate">{t.name}</span>
                <span className="text-[var(--text-muted)] tabular-nums shrink-0">
                  {t.count} · {pct}%{" "}
                  <span className="opacity-70">({t.done} done)</span>
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-[var(--border)] overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${pct}%`, backgroundColor: t.color ?? "var(--primary)" }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------------

function Stat({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  testId: string;
}) {
  return (
    <div className="rounded-md border border-[var(--border)] px-2 py-1.5" data-testid={testId}>
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      <div className="text-lg font-semibold text-[var(--text)] tabular-nums">{value}</div>
      {hint ? <div className="text-[10px] text-[var(--text-muted)]">{hint}</div> : null}
    </div>
  );
}
