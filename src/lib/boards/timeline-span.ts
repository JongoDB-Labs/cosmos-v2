/**
 * The date span a Timeline / Gantt row actually OCCUPIES on screen.
 *
 * The chart draws a row from two different date pairs. Once an item has
 * started, the SOLID bar comes from the actuals (`actualStart` -> `completedAt`,
 * or today while it is still running); the planned dates drive the un-started
 * phantom bar and the amber "started late" drift phantom. The axis has to cover
 * BOTH — see `paintedSpan`.
 *
 * This exists because the axis used to be derived from the planned dates alone
 * while the bars were positioned from the actual ones. The two disagreed for any
 * item that began earlier than anything on the board was planned to: it was laid
 * out at a NEGATIVE x, and the outermost `<svg>` (which clips by default) simply
 * cut it off — removing the head of the solid bar and part of the green
 * "started early" phantom, which is the only phantom whose left edge can precede
 * every planned start.
 *
 * Dates in, dates out — no pixels, so the axis and the bars cannot drift apart
 * again by rounding.
 */

/** The date fields a span is derived from. Loose on purpose: `WorkItem` carries
 *  ISO strings, tests and server code carry `Date`s. */
export interface TimelineSpanItem {
  startDate: string | Date | null;
  dueDate: string | Date | null;
  actualStart: string | Date | null;
  completedAt: string | Date | null;
  createdAt: string | Date;
}

export interface Span {
  start: Date;
  end: Date;
}

function asDate(v: string | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

/** Calendar-day arithmetic (not +n*86400000), so a span that crosses a DST
 *  boundary still lands on the same wall-clock day the bar renderer uses. */
function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** What the PLAN says: the span the un-started phantom bar is drawn at, and the
 *  outer bound of the amber phantom. Mirrors the renderer's fallbacks exactly —
 *  no start date falls back to creation, no due date to a week of work. */
export function plannedSpan(item: TimelineSpanItem): Span {
  const start = item.startDate ? asDate(item.startDate) : asDate(item.createdAt);
  const end = item.dueDate ? asDate(item.dueDate) : addDays(start, 7);
  return { start, end };
}

/** What is drawn SOLID: the actual span once the item has started, else the
 *  plan (which is then the bar itself). `today` ends a run still in flight. */
export function solidSpan(item: TimelineSpanItem, today: Date): Span {
  const actualStart = item.actualStart ? asDate(item.actualStart) : null;
  if (!actualStart) return plannedSpan(item);
  return {
    start: actualStart,
    end: item.completedAt ? asDate(item.completedAt) : today,
  };
}

/**
 * Everything the row paints. This is what the axis must span.
 *
 * The union is taken over EVERY real date, not just the two spans, because a
 * recorded date can fall outside both of them. `solidSpan` reports the PLANNED
 * span for an item with a completion and no recorded start — correct, because
 * that is where its bar is drawn — but the drift mark still reaches the real
 * completion, and a milestone's solid diamond sits on it.
 *
 * That gap is what made milestones look as though they only drifted LATE: a
 * milestone carries a completion and usually no actual start, so one pulled IN
 * landed left of the axis origin and was clipped away by the <svg>, while a
 * slipped one was quietly absorbed by the axis padding. Both directions now
 * survive on their own merits rather than by luck.
 */
export function paintedSpan(item: TimelineSpanItem, today: Date): Span {
  const planned = plannedSpan(item);
  const solid = solidSpan(item, today);
  const dates: Date[] = [planned.start, planned.end, solid.start, solid.end];
  if (item.actualStart) dates.push(asDate(item.actualStart));
  if (item.completedAt) dates.push(asDate(item.completedAt));

  let start = dates[0];
  let end = dates[0];
  for (const d of dates) {
    if (d < start) start = d;
    if (d > end) end = d;
  }
  return { start, end };
}
