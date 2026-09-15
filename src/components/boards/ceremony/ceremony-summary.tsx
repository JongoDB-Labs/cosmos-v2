"use client";

import { StatCard } from "@/components/ui/stat-card";
import { formatDateMediumStable as fmt } from "@/lib/format/stable-date";
import type { CeremonyPayload } from "./use-ceremony";

/**
 * Sprint by the numbers.
 *
 * The headline count is POINTS and the completion percentage is ITEMS — the two
 * answer different questions, and showing a points figure under an item-based
 * percentage is how a report quietly misstates a sprint. `metrics.basis` says
 * which unit the sprint is actually estimated in.
 */
export function CeremonySummary({ data }: { data: CeremonyPayload }) {
  const { metrics, sprint, increment } = data;
  const itemPct =
    metrics.totalItems > 0
      ? Math.round((metrics.completedItems / metrics.totalItems) * 100)
      : 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Story points completed">
          <p className="text-3xl font-semibold tabular-nums">
            {metrics.completedPoints}
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            of {metrics.totalPoints} committed
          </p>
        </StatCard>

        <StatCard label="Sprint completion">
          <p className="text-3xl font-semibold tabular-nums">{itemPct}%</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            by item count
          </p>
        </StatCard>

        <StatCard label="Items delivered">
          <p className="text-3xl font-semibold tabular-nums">
            {metrics.completedItems}/{metrics.totalItems}
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            {metrics.basis === "points" ? "points-estimated" : "unestimated"} sprint
          </p>
        </StatCard>

        <StatCard label="Pacing">
          <p className="text-3xl font-semibold capitalize">
            {metrics.pacingStatus}
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            {metrics.pacing.toFixed(2)}× the ideal burndown line
          </p>
        </StatCard>
      </div>

      {/* Item completion, with what carried called out rather than left as an
          unexplained gap in the bar. */}
      <div>
        <div className="mb-2 flex items-baseline justify-between text-xs">
          <span className="font-medium uppercase tracking-wider text-[var(--text-muted)]">
            Item completion
          </span>
          <span className="tabular-nums text-[var(--text-muted)]">
            {metrics.completedItems} of {metrics.totalItems} items · {itemPct}%
          </span>
        </div>
        <div
          className="flex h-8 overflow-hidden rounded-[calc(var(--radius)-2px)] border border-[var(--border)]"
          role="img"
          aria-label={`${metrics.completedItems} of ${metrics.totalItems} items complete`}
        >
          <div
            className="bg-[var(--status-done)] transition-[width]"
            style={{ width: `${itemPct}%` }}
          />
          <div className="flex flex-1 items-center justify-center bg-[var(--surface)] text-xs text-[var(--text-muted)]">
            {metrics.incompleteItems > 0
              ? `${metrics.incompleteItems} carried →`
              : null}
          </div>
        </div>
      </div>

      <dl className="grid gap-4 sm:grid-cols-3">
        <ContextCard
          term="Sprint window"
          value={`${fmt(sprint.startDate)} – ${fmt(sprint.endDate)}`}
          detail={`Sprint ${sprint.number}${
            increment ? ` of ${increment.name}` : ""
          } · ${metrics.plannedDays} days`}
        />
        <ContextCard
          term="Program increment"
          value={increment?.name ?? "Not in a PI"}
          detail={
            increment
              ? `${fmt(increment.startDate)} – ${fmt(increment.endDate)}`
              : "This sprint has no parent increment"
          }
        />
        <ContextCard
          term="Sprint goal"
          value={sprint.goal || "No goal set"}
          detail={sprint.status}
        />
      </dl>
    </div>
  );
}

function ContextCard({
  term,
  value,
  detail,
}: {
  term: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <dt className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
        {term}
      </dt>
      <dd className="mt-1 text-sm font-semibold">{value}</dd>
      <dd className="mt-0.5 text-xs text-[var(--text-muted)]">{detail}</dd>
    </div>
  );
}
