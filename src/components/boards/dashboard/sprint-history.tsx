"use client";

import { useMemo } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { TrendingUp } from "lucide-react";
import {
  sprintTrend,
  piRollup,
  type TrendIntervalLike,
} from "@/lib/intervals/sprint-trend";

/**
 * Sprint Health beyond the sprint in flight.
 *
 * Both views read `intervals.report`, written when a sprint is completed — so
 * they cost no extra query and cannot disagree with what the review board showed
 * at the time.
 *
 * Sprints completed before velocity was recorded are omitted rather than drawn
 * as zero: "no velocity recorded" and "delivered nothing" are different facts,
 * and the second is an accusation the data does not support.
 */

/** Shared bar-chart row, so the two views read as one design. */
function TrendBars({
  points,
  max,
  valueOf,
  labelOf,
}: {
  points: { id: string; name: string }[];
  max: number;
  valueOf: (p: { id: string }) => number;
  labelOf: (p: { id: string }) => string;
}) {
  return (
    <ul className="space-y-2">
      {points.map((p) => {
        const v = valueOf(p);
        // Guarded: every sprint at zero would otherwise divide by zero and give
        // every bar NaN width.
        const pct = max > 0 ? Math.round((v / max) * 100) : 0;
        return (
          <li key={p.id} className="flex items-center gap-3">
            <span className="w-28 shrink-0 truncate text-xs text-[var(--text-muted)]">
              {p.name}
            </span>
            <div className="h-5 flex-1 overflow-hidden rounded-sm bg-[var(--surface)] ring-1 ring-[var(--border)]">
              <div
                className="h-full bg-[var(--primary)] transition-[width]"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="w-24 shrink-0 text-right text-xs tabular-nums">
              {labelOf(p)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function SprintTrendView({ intervals }: { intervals: TrendIntervalLike[] }) {
  const points = useMemo(() => sprintTrend(intervals), [intervals]);

  if (points.length === 0) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No completed sprints yet"
        description="Velocity is recorded when a sprint is completed. Finish a sprint and it will appear here — sprints closed before velocity was recorded are left out rather than shown as zero."
      />
    );
  }

  const maxVelocity = Math.max(...points.map((p) => p.velocity));
  const avg = Math.round(points.reduce((s, p) => s + p.velocity, 0) / points.length);
  const last = points[points.length - 1];

  return (
    <div className="space-y-6">
      <dl className="grid gap-4 sm:grid-cols-3">
        <Figure label="Sprints completed" value={String(points.length)} />
        <Figure label="Average velocity" value={`${avg} pts`} />
        <Figure
          label="Most recent"
          value={`${last.velocity} pts`}
          detail={last.name}
        />
      </dl>

      <section>
        <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
          Velocity by sprint
        </h3>
        <TrendBars
          points={points}
          max={maxVelocity}
          valueOf={(p) => points.find((x) => x.id === p.id)!.velocity}
          labelOf={(p) => `${points.find((x) => x.id === p.id)!.velocity} pts`}
        />
      </section>

      <section>
        <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
          Completion by sprint
        </h3>
        <TrendBars
          points={points}
          max={100}
          valueOf={(p) => points.find((x) => x.id === p.id)!.completionPct}
          labelOf={(p) => {
            const x = points.find((y) => y.id === p.id)!;
            return `${x.completionPct}% · ${x.completedItems}/${x.totalItems}`;
          }}
        />
      </section>
    </div>
  );
}

export function PiRollupView({
  intervals,
}: {
  intervals: TrendIntervalLike[];
}) {
  // A Program Increment is an interval that CONTAINS sprints.
  const pis = useMemo(
    () => intervals.filter((i) => intervals.some((c) => c.parentId === i.id)),
    [intervals],
  );

  if (pis.length === 0) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No Program Increments yet"
        description="Nest sprints under a Program Increment and its totals will roll up here."
      />
    );
  }

  return (
    <div className="space-y-8">
      {pis.map((pi) => {
        const r = piRollup(pi, intervals);
        return (
          <section key={pi.id}>
            <h3 className="mb-3 text-sm font-semibold">{pi.name}</h3>
            <dl className="mb-4 grid gap-4 sm:grid-cols-4">
              <Figure label="Points delivered" value={String(r.velocity)} />
              <Figure
                label="Items"
                value={`${r.completedItems}/${r.totalItems}`}
                detail={`${r.completionPct}% complete`}
              />
              <Figure label="Sprints completed" value={String(r.sprintsCompleted)} />
              <Figure label="Average velocity" value={`${r.averageVelocity} pts`} />
            </dl>
            {r.sprints.length > 0 ? (
              <TrendBars
                points={r.sprints}
                max={Math.max(...r.sprints.map((s) => s.velocity), 1)}
                valueOf={(p) => r.sprints.find((x) => x.id === p.id)!.velocity}
                labelOf={(p) => `${r.sprints.find((x) => x.id === p.id)!.velocity} pts`}
              />
            ) : (
              <p className="text-sm text-[var(--text-muted)]">
                Nothing completed in this increment yet.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Figure({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <dt className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
      {detail ? (
        <dd className="mt-0.5 text-xs text-[var(--text-muted)]">{detail}</dd>
      ) : null}
    </div>
  );
}
