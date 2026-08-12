/**
 * Burndown and burnup for an interval.
 *
 * WHY THIS EXISTS: Sprint Health could say what the sprint looks like NOW and
 * what past sprints finished at, but nothing about the shape of the sprint in
 * flight — the one question a standup actually asks. It needs no new table:
 * `work_items.completed_at` already records when each item finished, and the
 * interval carries its own start and end.
 *
 * THE HONESTY RULES THIS FILE ENFORCES, because a chart is read as fact:
 *
 *  - **Nothing is drawn past today.** A remaining-line continued to the sprint
 *    end reads as "we are on target for the rest of the sprint", which is a
 *    claim about the future made out of no data. Future days carry the ideal
 *    line only.
 *  - **Done-but-undated items are attributed to TODAY, never to day zero.** An
 *    item sitting in a DONE column with no `completed_at` is genuinely finished
 *    but we do not know when. Backdating it invents progress that may never have
 *    happened on those days; dating it today understates the past but can never
 *    overstate it. The count is reported so a reader can see how much of the
 *    curve is affected rather than trusting a line built partly on guesses.
 *  - **The ideal line runs over WORKING days.** Across a two-week sprint a
 *    calendar-day ideal implies weekend delivery and makes every team look
 *    behind on a Monday. Weekends are flat.
 *  - **`unit: "count"` is the default elsewhere in the product** because story
 *    points are optional and sparsely filled; a points chart built on a fraction
 *    of the items is worse than an honest count. This module supports both and
 *    reports the coverage so the caller can say which is trustworthy.
 */

export interface BurndownItemLike {
  id: string;
  /** Null or 0 when unestimated. */
  storyPoints: number | null;
  /** When the item actually finished, if recorded. */
  completedAt: string | Date | null;
  /** Whether the item sits in a DONE-category column right now. */
  done: boolean;
}

export type BurndownUnit = "count" | "points";

export interface BurndownPoint {
  /** ISO calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Work still open at the END of this day. Null for days after today. */
  remaining: number | null;
  /** Cumulative work finished by the end of this day. Null after today. */
  completed: number | null;
  /** The straight line from full scope to zero, across working days. */
  ideal: number;
  /** Total scope as known today — flat, until scope history is wired in. */
  scope: number;
  isWeekend: boolean;
  isFuture: boolean;
  isToday: boolean;
}

export interface BurndownSeries {
  points: BurndownPoint[];
  unit: BurndownUnit;
  /** Total work in the interval, in `unit`. */
  scope: number;
  /** Work finished so far, in `unit`. */
  completed: number;
  /** Work still open, in `unit`. */
  remaining: number;
  /**
   * Items that are done but carry no completion date, so their contribution sits
   * on today rather than on the day it happened. Surface this — it is the one
   * number that tells a reader how much of the curve is reconstructed.
   */
  undatedCompletions: number;
  /** Items carrying a usable estimate, over items total — for `points` honesty. */
  pointsCoverage: { estimated: number; total: number };
  /** Working days in the interval, the denominator of the ideal line. */
  workingDays: number;
}

/** `YYYY-MM-DD` for a date, in LOCAL time — the calendar the user is reading. */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local midnight, so day comparisons never straddle a timezone boundary. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isWeekend(d: Date): boolean {
  const wd = d.getDay();
  return wd === 0 || wd === 6;
}

function weight(item: BurndownItemLike, unit: BurndownUnit): number {
  if (unit === "count") return 1;
  const p = item.storyPoints;
  return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : 0;
}

/**
 * Every calendar day from `start` to `end` inclusive. Returns [] when the range
 * is inverted rather than looping forever — a misconfigured interval must not
 * hang the page.
 */
function eachDay(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  const a = startOfDay(start);
  const b = startOfDay(end);
  if (b < a) return out;
  for (let d = a; d <= b; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    out.push(d);
    if (out.length > 400) break; // a sprint is not a year; refuse to build a runaway series
  }
  return out;
}

export function burndown(opts: {
  start: Date;
  end: Date;
  /** Injected, never read from the clock here — a pure function must be testable. */
  today: Date;
  items: BurndownItemLike[];
  unit?: BurndownUnit;
}): BurndownSeries {
  const unit: BurndownUnit = opts.unit ?? "count";
  const days = eachDay(opts.start, opts.end);
  const today = startOfDay(opts.today);

  const scope = opts.items.reduce((s, i) => s + weight(i, unit), 0);

  const estimated = opts.items.filter(
    (i) => typeof i.storyPoints === "number" && Number.isFinite(i.storyPoints) && i.storyPoints > 0,
  ).length;

  // Bucket each completion onto a day. A done item with no date lands on today
  // (see the header): understating the past is recoverable, inventing it is not.
  const completedByDay = new Map<string, number>();
  let undatedCompletions = 0;
  let completedTotal = 0;

  for (const item of opts.items) {
    const w = weight(item, unit);
    let when: Date | null = null;

    if (item.completedAt) {
      const parsed = new Date(item.completedAt);
      if (!Number.isNaN(parsed.getTime())) when = startOfDay(parsed);
    }

    // `done` is the authority on WHETHER it is finished; `completedAt` only on
    // when. An item with a completion date that is not in a done column is not
    // counted as delivered — reopened work must show back on the remaining line.
    if (!item.done) continue;

    if (!when) {
      undatedCompletions += 1;
      when = today;
    }
    completedTotal += w;
    const k = dayKey(when);
    completedByDay.set(k, (completedByDay.get(k) ?? 0) + w);
  }

  const workingDays = days.filter((d) => !isWeekend(d)).length;

  // The ideal burns only on working days, so it is flat across a weekend rather
  // than implying Saturday delivery.
  const perWorkingDay = workingDays > 0 ? scope / workingDays : 0;

  let cumulative = 0;
  let workingElapsed = 0;

  const points: BurndownPoint[] = days.map((d) => {
    const k = dayKey(d);
    const weekend = isWeekend(d);
    if (!weekend) workingElapsed += 1;

    const future = d > today;
    const isToday = d.getTime() === today.getTime();

    // Completions accumulate only up to today; beyond it there is no data, and
    // a flat continuation would read as a forecast.
    if (!future) cumulative += completedByDay.get(k) ?? 0;

    const ideal = Math.max(0, scope - perWorkingDay * workingElapsed);

    return {
      date: k,
      remaining: future ? null : Math.max(0, scope - cumulative),
      completed: future ? null : cumulative,
      ideal: Number(ideal.toFixed(2)),
      scope,
      isWeekend: weekend,
      isFuture: future,
      isToday,
    };
  });

  return {
    points,
    unit,
    scope,
    completed: completedTotal,
    remaining: Math.max(0, scope - completedTotal),
    undatedCompletions,
    pointsCoverage: { estimated, total: opts.items.length },
    workingDays,
  };
}
