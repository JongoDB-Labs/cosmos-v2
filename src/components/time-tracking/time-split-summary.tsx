"use client";

import { splitTime, type SplittableEntry } from "@/lib/time/internal-categories";

const fmt = (h: number) => `${h.toFixed(2)} h`;

/**
 * Project time and internal time, side by side, for the entries on screen.
 *
 * Internal time (overhead, business development, professional development…)
 * is the cost of running the practice rather than delivering a project, so it
 * is shown as its own figure with its own breakdown instead of disappearing
 * into a "no project" row. Renders nothing until there is internal time to
 * report — an org that never categorises sees today's page.
 */
export function TimeSplitSummary({
  entries,
  categories,
}: {
  entries: readonly SplittableEntry[];
  /** The org's categories, for display order. */
  categories: readonly string[];
}) {
  const split = splitTime(entries, categories);
  if (split.internalHours === 0) return null;
  return (
    <section
      aria-label="Project and internal time"
      className="flex flex-wrap items-start gap-x-8 gap-y-3 rounded-lg border bg-muted/30 px-4 py-3 text-sm"
    >
      <div>
        <div className="text-xs text-muted-foreground">Project time</div>
        <div className="font-medium tabular-nums" data-testid="split-project">{fmt(split.projectHours)}</div>
      </div>
      <div>
        <div className="text-xs text-muted-foreground">Internal time</div>
        <div className="font-medium tabular-nums" data-testid="split-internal">{fmt(split.internalHours)}</div>
      </div>
      {split.unassignedHours > 0 && (
        <div>
          <div className="text-xs text-muted-foreground">No project or category</div>
          <div className="font-medium tabular-nums" data-testid="split-unassigned">{fmt(split.unassignedHours)}</div>
        </div>
      )}
      <ul aria-label="Internal time by category" className="flex flex-wrap gap-x-4 gap-y-1 self-end text-muted-foreground">
        {split.byCategory.map((c) => (
          <li key={c.category}>
            {c.category}: <span className="tabular-nums text-foreground">{fmt(c.hours)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
