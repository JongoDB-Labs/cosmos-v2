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
  MIN_SPREAD_SAMPLES,
  type DeliveryItemLike,
  type ThroughputInterval,
} from "@/lib/dashboard/delivery-metrics";
import {
  scopeChange,
  carryover,
  predictability,
  MIN_PREDICTABILITY_SAMPLES,
  type IntervalChange,
  type ScopeItemLike,
} from "@/lib/dashboard/scope-change";
import {
  impediments,
  objectiveRollup,
  type WorkItemLinkLike,
  type ObjectiveLike,
} from "@/lib/dashboard/impediments";
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
              <> (±{Math.round(summary.variability * 100)}% variation)</>
            ) : (
              // Say what is missing rather than printing a spread of one sample.
              // "±0% variation" is arithmetically correct and reads as "this team
              // never varies" — seen on production with a single closed sprint.
              <>
                {" "}
                — too few to show variation yet, which needs{" "}
                {MIN_SPREAD_SAMPLES}
              </>
            )}
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

// ---------------------------------------------------------------------------

/**
 * Scope change and commitment — the two numbers a stakeholder asks for and the
 * board has never shown. A team that finished 90% of a sprint it doubled halfway
 * through is in a completely different position from one that finished 90% of
 * what it committed to, and until now those rendered identically.
 */
export function ScopeChangePanel({
  items,
  intervals,
  changes,
  loading,
  truncated,
}: {
  items: DeliveryItemLike[];
  intervals: Interval[];
  changes: IntervalChange[];
  loading?: boolean;
  truncated?: boolean;
}) {
  const sprints = useMemo(
    () =>
      ceremonySelectableIntervals(intervals).map((i) => ({
        id: i.id,
        name: i.name,
        startDate: i.startDate,
        endDate: i.endDate,
        status: i.status,
      })),
    [intervals],
  );

  const scopeItems: ScopeItemLike[] = useMemo(
    () => items.map((i) => ({ id: i.id, intervalId: i.intervalId, done: i.done })),
    [items],
  );

  const rows = useMemo(
    () => scopeChange(changes, sprints, scopeItems),
    [changes, sprints, scopeItems],
  );

  const question = "Did we finish what we said we would, and what changed after we said it?";

  if (loading) {
    return (
      <PanelShell title="Commitment and scope change" question={question}>
        <NotEnoughData what="Reading the interval history…" />
      </PanelShell>
    );
  }

  if (rows.length === 0) {
    return (
      <PanelShell title="Commitment and scope change" question={question}>
        <NotEnoughData what="This project has no sprints yet, so there is no commitment to measure against." />
      </PanelShell>
    );
  }

  const churned = rows.filter((r) => r.added + r.removed > 0).length;

  return (
    <PanelShell
      title="Commitment and scope change"
      question={question}
      footnote={
        <>
          &ldquo;Committed&rdquo; is reconstructed from the interval history: what is in the
          sprint now, minus what arrived after it started, plus what left. Moves made
          BEFORE a sprint starts are planning and are not counted as change.
          {churned === 0 ? " No sprint here changed after it started." : null}
          {truncated ? (
            <span className="text-[var(--warning,#f97316)]">
              {" "}
              History was truncated, so older churn is under-reported.
            </span>
          ) : null}
        </>
      }
    >
      <ul className="space-y-2.5">
        {rows.map((r) => {
          const kept = r.commitmentKept;
          return (
            <li key={r.intervalId} data-testid={`scope-${r.intervalId}`}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-[var(--text)] truncate">{r.name}</span>
                <span className="text-[var(--text-muted)] tabular-nums shrink-0">
                  {kept === null ? (
                    // Finishing 3 of 0 is not 300% delivery — it is a sprint
                    // that was empty at planning, which `+N` already says.
                    <span title="nothing was committed at planning">no commitment</span>
                  ) : (
                    <>{Math.round(kept)}% of {r.committed} kept</>
                  )}
                  {r.added > 0 ? <span className="text-[var(--warning,#f97316)]"> +{r.added}</span> : null}
                  {r.removed > 0 ? <span className="text-[var(--text-muted)]"> −{r.removed}</span> : null}
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-[var(--border)] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[var(--primary)]"
                  style={{ width: `${Math.min(100, kept ?? 0)}%` }}
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

/**
 * Carryover and predictability — the two retro questions that need history
 * rather than a snapshot.
 *
 * They share a panel because they share a cause: work that keeps rolling is
 * exactly what makes a team unpredictable, and seeing the two side by side is
 * what turns "we are at 60%" into "we are at 60% because these four tickets
 * have slipped three sprints running".
 */
export function CarryoverPanel({
  items,
  intervals,
  changes,
  loading,
}: {
  items: DeliveryItemLike[];
  intervals: Interval[];
  changes: IntervalChange[];
  loading?: boolean;
}) {
  const sprints = useMemo(
    () =>
      ceremonySelectableIntervals(intervals).map((i) => ({
        id: i.id,
        name: i.name,
        startDate: i.startDate,
        endDate: i.endDate,
        status: i.status,
      })),
    [intervals],
  );

  const flow = useMemo(() => carryover(changes, sprints), [changes, sprints]);

  const closedIds = useMemo(
    () => new Set(sprints.filter((s) => s.status === "COMPLETED").map((s) => s.id)),
    [sprints],
  );
  const scopeItems: ScopeItemLike[] = useMemo(
    () => items.map((i) => ({ id: i.id, intervalId: i.intervalId, done: i.done })),
    [items],
  );
  const reliability = useMemo(
    () => predictability(scopeChange(changes, sprints, scopeItems), closedIds),
    [changes, sprints, scopeItems, closedIds],
  );

  const question = "What keeps rolling into the next sprint, and can we be relied on?";

  if (loading) {
    return (
      <PanelShell title="Carryover and predictability" question={question}>
        <NotEnoughData what="Reading the interval history…" />
      </PanelShell>
    );
  }

  const moved = flow.rows.filter((r) => r.carriedIn + r.carriedOut > 0);

  return (
    <PanelShell
      title="Carryover and predictability"
      question={question}
      footnote={
        reliability.shortfall ? (
          // States the shortfall rather than computing a spread nobody should
          // act on. This number gets quoted at people.
          <>
            Predictability needs {MIN_PREDICTABILITY_SAMPLES} closed sprints with
            something committed; there {reliability.shortfall.has === 1 ? "is" : "are"}{" "}
            {reliability.shortfall.has}.
          </>
        ) : (
          <>
            Keeps {Math.round(reliability.mean!)}% of its commitment on average
            across {reliability.samples} closed sprints, varying by ±
            {Math.round(reliability.stdDev!)} points. Carryover counts sprint-to-sprint
            moves only — work sent back to the backlog is descoping, not a slip.
          </>
        )
      }
    >
      {moved.length === 0 ? (
        <NotEnoughData what="Nothing has moved between sprints yet, so no work has been carried." />
      ) : (
        <>
          <ul className="space-y-2">
            {moved.map((r) => (
              <li key={r.intervalId} data-testid={`carryover-${r.intervalId}`}>
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="text-[var(--text)] truncate">{r.name}</span>
                  <span className="text-[var(--text-muted)] tabular-nums shrink-0">
                    {r.carriedIn > 0 ? <>inherited {r.carriedIn}</> : null}
                    {r.carriedIn > 0 && r.carriedOut > 0 ? " · " : null}
                    {r.carriedOut > 0 ? (
                      <span className="text-[var(--warning,#f97316)]">slipped {r.carriedOut}</span>
                    ) : null}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {flow.repeatOffenders.length > 0 ? (
            <p className="mt-3 text-[11px] text-[var(--warning,#f97316)]" data-testid="repeat-offenders">
              {flow.repeatOffenders.length}{" "}
              {flow.repeatOffenders.length === 1 ? "item has" : "items have"} slipped more
              than once — the most, {flow.repeatOffenders[0].hops} times.
            </p>
          ) : null}
        </>
      )}
    </PanelShell>
  );
}

// ---------------------------------------------------------------------------

/** Days rendered for a block: whole days, because "3.4 days blocked" is noise. */
function blockedFor(days: number): string {
  if (days < 1) return "today";
  const d = Math.floor(days);
  return d === 1 ? "1 day" : `${d} days`;
}

/**
 * What is stuck, and for how long.
 *
 * The age is measured from when the BLOCK WAS RECORDED, not from when work
 * actually stopped — nobody records the latter. The panel says which it is
 * rather than implying the stronger claim.
 */
export function ImpedimentsPanel({
  items,
  links,
  now,
  loading,
  bare,
}: {
  items: DeliveryItemLike[];
  links: WorkItemLinkLike[];
  /** Injected so the panel is testable and every row ages off one instant. */
  now?: Date;
  loading?: boolean;
  bare?: boolean;
}) {
  const doneIds = useMemo(
    () => new Set(items.filter((i) => i.done).map((i) => i.id)),
    [items],
  );
  const visibleIds = useMemo(() => new Set(items.map((i) => i.id)), [items]);

  const result = useMemo(
    () => impediments(links, doneIds, now ?? new Date()),
    [links, doneIds, now],
  );

  // Honour the board filters: a blocked item outside the current filter is not
  // this reader's problem right now, and showing it would make the filter a lie.
  const blocked = useMemo(
    () => result.blocked.filter((b) => visibleIds.has(b.workItemId)),
    [result.blocked, visibleIds],
  );

  const question = "What is stuck, and for how long?";

  if (loading) {
    return (
      <PanelShell title="Blocked work" question={question} bare={bare}>
        <NotEnoughData what="Reading the dependency links…" />
      </PanelShell>
    );
  }

  return (
    <PanelShell
      title="Blocked work"
      question={question}
      bare={bare}
      footnote={
        <>
          Measured from when the block was recorded, not from when work stopped —
          nothing records that.
          {result.staleLinks > 0 ? (
            <> {result.staleLinks} blocking {result.staleLinks === 1 ? "link points" : "links point"} at
            finished work and {result.staleLinks === 1 ? "is" : "are"} not counted.</>
          ) : null}
        </>
      }
    >
      {blocked.length === 0 ? (
        <NotEnoughData what="Nothing here is blocked. Dependencies are recorded as BLOCKS / BLOCKED BY links on an issue." />
      ) : (
        <ul className="space-y-2">
          {blocked.map((b) => (
            <li key={b.workItemId} data-testid={`blocked-${b.workItemId}`} className="text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[var(--text)] truncate">
                  #{b.ticketNumber} {b.title}
                </span>
                <span className="shrink-0 tabular-nums text-[var(--warning,#f97316)]">
                  {blockedFor(b.daysBlocked)}
                </span>
              </div>
              <div className="text-[var(--text-muted)] truncate">
                waiting on #{b.blockedByTicketNumber} {b.blockedByTitle}
              </div>
            </li>
          ))}
        </ul>
      )}
    </PanelShell>
  );
}

// ---------------------------------------------------------------------------

/**
 * Increment objectives, split by commitment.
 *
 * The split is the point: SAFe stretch objectives are deliberately outside the
 * commitment so a team can surface upside without being judged on it. Folding
 * them into one percentage is how a PI report ends up reading worse than the
 * increment actually went.
 */
export function PiObjectivesPanel({
  intervals,
  objectives,
  loading,
}: {
  intervals: Interval[];
  objectives: ObjectiveLike[];
  loading?: boolean;
}) {
  // A Program Increment is an interval that CONTAINS other intervals.
  const pis = useMemo(
    () => intervals.filter((i) => intervals.some((c) => c.parentId === i.id)),
    [intervals],
  );

  const question = "Which increment objectives are met, at risk, or missed?";

  if (loading) {
    return (
      <PanelShell title="Increment objectives" question={question}>
        <NotEnoughData what="Reading objectives…" />
      </PanelShell>
    );
  }

  if (pis.length === 0) {
    return (
      <PanelShell title="Increment objectives" question={question}>
        <NotEnoughData what="No Program Increments yet. Nest sprints under one and its objectives roll up here." />
      </PanelShell>
    );
  }

  return (
    <div className="space-y-4">
      {pis.map((pi) => {
        const roll = objectiveRollup(objectives, pi.id);
        const total = roll.committed.length + roll.stretch.length;
        return (
          <PanelShell
            key={pi.id}
            title={`${pi.name} objectives`}
            question={question}
            footnote={
              roll.committedProgress === null ? (
                // 0% would read as total failure rather than as an empty plan.
                <>Nothing is committed for this increment{roll.stretch.length > 0 ? ", though there are stretch objectives" : ""}.</>
              ) : (
                <>
                  {roll.met} of {roll.committed.length} committed{" "}
                  {roll.committed.length === 1 ? "objective" : "objectives"} met,{" "}
                  {Math.round(roll.committedProgress)}% average progress.
                  {roll.stretch.length > 0 ? (
                    <> {roll.stretch.length} stretch{" "}
                    {roll.stretch.length === 1 ? "objective is" : "objectives are"} excluded from
                    that figure — they are upside, not a promise.</>
                  ) : null}
                </>
              )
            }
          >
            {total === 0 ? (
              <NotEnoughData what="No objectives recorded for this increment." />
            ) : (
              <ul className="space-y-2" data-testid={`pi-objectives-${pi.id}`}>
                {[...roll.committed, ...roll.stretch].map((o) => {
                  const isStretch = o.committed === false;
                  return (
                    <li key={o.id}>
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="text-[var(--text)] truncate">
                          {o.title}
                          {isStretch ? (
                            <span className="ml-1.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                              stretch
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
                          {Math.round(o.progress)}%
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-[var(--border)] overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, Math.max(0, o.progress))}%`,
                            backgroundColor: isStretch ? "var(--text-muted)" : "var(--primary)",
                          }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </PanelShell>
        );
      })}
    </div>
  );
}
