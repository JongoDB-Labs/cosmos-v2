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
 * Everything the row paints — the union of the plan and the actuals. This is
 * what the axis must span.
 *
 * The union covers every drift phantom for free: amber runs planned start ->
 * actual start and green runs actual start -> planned start, so both sit
 * between the two starts; red ends at the actual end. Nothing a row draws falls
 * outside `[min(starts), max(ends)]`.
 */
export function paintedSpan(item: TimelineSpanItem, today: Date): Span {
  const planned = plannedSpan(item);
  const solid = solidSpan(item, today);
  return {
    start: planned.start < solid.start ? planned.start : solid.start,
    end: planned.end > solid.end ? planned.end : solid.end,
  };
}
