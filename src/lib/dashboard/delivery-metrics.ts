/**
 * Delivery metrics for Sprint Health: cycle time, throughput, and work-type mix.
 *
 * WHY THESE THREE FIRST. Sprint Health could describe the sprint in flight and
 * what past sprints finished at, and nothing else — no answer to "how long does
 * a thing take once we start it?", "are we finishing more or fewer items than we
 * used to?", or "where is our capacity actually going?". Those are the questions
 * a retro asks, and all three are already answerable from columns the product
 * has been writing for months: `actual_start`, `completed_at`, `work_category`
 * and the work-item type. Nothing here needs a new table or an activity replay.
 *
 * THE HONESTY RULES THIS FILE ENFORCES, because a metric is read as fact and a
 * delivery metric is read as a judgement about people:
 *
 *  - **Coverage travels with every number.** A median cycle time computed over
 *    the 12 items that happen to carry an `actual_start`, presented beside 96
 *    finished items, is not a median cycle time — it is a median over whoever
 *    remembered to press Start. Each result reports how much of the work it
 *    actually describes so the caller can say so out loud.
 *  - **Broken data is excluded and COUNTED, never repaired.** An item that
 *    finished before it started is a data fault. Clamping it to zero invents a
 *    plausible number out of a known-bad one and buries the fault forever; it is
 *    dropped from the statistics and surfaced as an anomaly instead.
 *  - **A sprint still running is marked partial.** Three days into a sprint a
 *    team has delivered three days of work, and charting that against finished
 *    sprints draws a cliff that reads as collapse. The point is still returned —
 *    hiding it is its own lie — but flagged, so the renderer can style it as
 *    incomplete rather than as a fall.
 *  - **`done` (the column category) decides WHETHER something is finished;
 *    `completed_at` only decides WHEN.** Same rule as the burndown module, and
 *    for the same reason: an item reopened after completion still carries its old
 *    timestamp, and trusting the timestamp alone counts it as delivered forever.
 *  - **Counts are the default unit, points are opt-in.** Story points are on 23%
 *    of items in real data. A points figure over a quarter of the work, shown
 *    without that fraction, is worse than an honest count.
 */

export interface DeliveryItemLike {
  id: string;
  intervalId: string | null;
  /** Null or 0 when unestimated. */
  storyPoints: number | null;
  /** When work actually began, if recorded. */
  actualStart: string | Date | null;
  /** When the item actually finished, if recorded. */
  completedAt: string | Date | null;
  /** Whether the item sits in a DONE-category column right now. */
  done: boolean;
  /** Work-item type — stable key, plus how it should read and colour. */
  typeKey: string;
  typeName: string;
  typeColor: string | null;
  /** SAFe classification: customer-facing value vs the work that enables it. */
  workCategory: "BUSINESS" | "ENABLER";
}

const MS_PER_DAY = 86_400_000;

/** Usable estimate, or 0 — the one place "is this estimated?" is decided. */
function points(item: DeliveryItemLike): number {
  const p = item.storyPoints;
  return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : 0;
}

function isEstimated(item: DeliveryItemLike): boolean {
  return points(item) > 0;
}

/** A parsed date, or null for absent AND for unparseable — callers treat both alike. */
function parseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Cycle time
// ---------------------------------------------------------------------------

export interface CycleTimeBucket {
  label: string;
  /** Inclusive lower bound in days. */
  from: number;
  /** Exclusive upper bound in days; null on the open-ended final bucket. */
  to: number | null;
  count: number;
}

export interface CycleTimeResult {
  /** Per-item durations in days, ascending. Fractional: a same-day item is not zero. */
  days: number[];
  median: number | null;
  /** The 85th percentile — the "most things land inside this" number teams commit to. */
  p85: number | null;
  mean: number | null;
  /**
   * How much of the finished work this actually describes. `measured` items had
   * both timestamps; `done` is every finished item, measurable or not.
   */
  coverage: { measured: number; done: number };
  /** Finished items whose completion precedes their start — excluded, not repaired. */
  anomalies: number;
  histogram: CycleTimeBucket[];
}

/**
 * Nearest-rank percentile on a sorted ascending array.
 *
 * Chosen over linear interpolation deliberately: every value it returns is a
 * duration some real item actually took, so "p85 is 9.4 days" can always be
 * traced to a ticket. An interpolated 9.4 that no item exhibits is harder to
 * defend in the one conversation this number exists for.
 */
function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}

const CYCLE_BUCKETS: Array<{ label: string; from: number; to: number | null }> = [
  { label: "< 1 day", from: 0, to: 1 },
  { label: "1–2 days", from: 1, to: 3 },
  { label: "3–5 days", from: 3, to: 6 },
  { label: "6–10 days", from: 6, to: 11 },
  { label: "11–20 days", from: 11, to: 21 },
  { label: "> 20 days", from: 21, to: null },
];

/**
 * How long finished work took, from `actualStart` to `completedAt`.
 *
 * CALENDAR days, not working days — matching what Jira reports by default, so a
 * team migrating does not find the same sprint suddenly 30% faster. An item
 * started Friday and finished Monday genuinely sat unfinished over the weekend,
 * and a customer waiting on it experienced three days.
 */
export function cycleTime(items: readonly DeliveryItemLike[]): CycleTimeResult {
  const done = items.filter((i) => i.done);
  const days: number[] = [];
  let anomalies = 0;

  for (const item of done) {
    const start = parseDate(item.actualStart);
    const end = parseDate(item.completedAt);
    if (!start || !end) continue;

    const delta = (end.getTime() - start.getTime()) / MS_PER_DAY;
    // Finished-before-started is broken data, not a fast ticket. Excluded from
    // the statistics and reported, so the fault stays visible.
    if (delta < 0) {
      anomalies += 1;
      continue;
    }
    days.push(delta);
  }

  days.sort((a, b) => a - b);

  const histogram = CYCLE_BUCKETS.map((b) => ({
    ...b,
    count: days.filter((d) => d >= b.from && (b.to === null || d < b.to)).length,
  }));

  return {
    days,
    median: percentile(days, 50),
    p85: percentile(days, 85),
    mean: days.length ? days.reduce((s, d) => s + d, 0) / days.length : null,
    coverage: { measured: days.length, done: done.length },
    anomalies,
    histogram,
  };
}

// ---------------------------------------------------------------------------
// Throughput
// ---------------------------------------------------------------------------

export interface ThroughputInterval {
  id: string;
  name: string;
  status: string;
  startDate: string | Date;
  endDate: string | Date;
}

export interface ThroughputPoint {
  intervalId: string;
  name: string;
  /** Items finished, the honest default unit. */
  count: number;
  /** Points finished — trustworthy only in proportion to `estimated`. */
  points: number;
  /** Finished items carrying a usable estimate, over finished items. */
  estimated: number;
  /** Everything assigned to the interval, finished or not. */
  total: number;
  /** True while the interval is still running: a partial bar, not a drop. */
  isPartial: boolean;
}

/**
 * Items finished per interval, oldest first.
 *
 * Attribution is by `intervalId` — the sprint the item ENDED in — not by which
 * sprint's dates contain `completedAt`. Those differ for carried-over work, and
 * this is the version a team recognises: "we finished eleven things in sprint 7"
 * means eleven things left sprint 7 done, including ones that arrived from
 * sprint 6.
 *
 * Intervals are returned even when they finished nothing. A sprint that
 * delivered zero is a fact about the team; omitting it closes the gap in the
 * chart and quietly redraws the trend as though the sprint never happened.
 */
export function throughput(
  items: readonly DeliveryItemLike[],
  intervals: readonly ThroughputInterval[],
): ThroughputPoint[] {
  const byInterval = new Map<string, DeliveryItemLike[]>();
  for (const item of items) {
    if (!item.intervalId) continue;
    const list = byInterval.get(item.intervalId);
    if (list) list.push(item);
    else byInterval.set(item.intervalId, [item]);
  }

  return intervals
    .slice()
    .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime())
    .map((interval) => {
      const assigned = byInterval.get(interval.id) ?? [];
      const finished = assigned.filter((i) => i.done);
      return {
        intervalId: interval.id,
        name: interval.name,
        count: finished.length,
        points: finished.reduce((s, i) => s + points(i), 0),
        estimated: finished.filter(isEstimated).length,
        total: assigned.length,
        isPartial: interval.status === "ACTIVE" || interval.status === "PLANNED",
      };
    });
}

/**
 * Mean and spread of the CLOSED points only.
 *
 * A rolling average that includes the sprint in flight drags the line toward
 * however far into it we are, which is the single easiest way to make a healthy
 * team look like it is decelerating every second Tuesday.
 */
export function throughputSummary(pointsSeries: readonly ThroughputPoint[]): {
  mean: number | null;
  /** Population standard deviation of the closed sprints' item counts. */
  stdDev: number | null;
  /** stdDev / mean — lower is more predictable. Null when mean is 0. */
  variability: number | null;
  closed: number;
} {
  const closed = pointsSeries.filter((p) => !p.isPartial);
  if (closed.length === 0) return { mean: null, stdDev: null, variability: null, closed: 0 };

  const counts = closed.map((p) => p.count);
  const mean = counts.reduce((s, c) => s + c, 0) / counts.length;
  const variance = counts.reduce((s, c) => s + (c - mean) ** 2, 0) / counts.length;
  const stdDev = Math.sqrt(variance);

  return {
    mean,
    stdDev,
    variability: mean > 0 ? stdDev / mean : null,
    closed: closed.length,
  };
}

// ---------------------------------------------------------------------------
// Work-type mix
// ---------------------------------------------------------------------------

export interface TypeSlice {
  key: string;
  name: string;
  color: string | null;
  count: number;
  points: number;
  /** Of `count`, how many are finished — so a slice can show progress, not just size. */
  done: number;
}

export interface WorkTypeMix {
  /** By work-item type (Story, Bug, Spike…), largest first. */
  byType: TypeSlice[];
  /** By SAFe classification. Always both entries, even at zero, so the split reads as a ratio. */
  byCategory: Array<{ category: "BUSINESS" | "ENABLER"; count: number; points: number; done: number }>;
  total: number;
  /** Items carrying a usable estimate — the points columns mean little without it. */
  estimated: number;
}

/**
 * Where capacity is going, cut two ways.
 *
 * BOTH cuts, because they answer different questions and each alone misleads.
 * Type ("we are 40% bugs") is what a team argues about in a retro. SAFe category
 * ("we are 80% business, 20% enabler") is what a portfolio review asks, and a
 * quarter of pure feature work with no enabler investment is invisible in the
 * type breakdown — Stories and Bugs both look like healthy delivery.
 */
export function workTypeMix(items: readonly DeliveryItemLike[]): WorkTypeMix {
  const types = new Map<string, TypeSlice>();

  for (const item of items) {
    const existing = types.get(item.typeKey);
    if (existing) {
      existing.count += 1;
      existing.points += points(item);
      if (item.done) existing.done += 1;
    } else {
      types.set(item.typeKey, {
        key: item.typeKey,
        name: item.typeName,
        color: item.typeColor,
        count: 1,
        points: points(item),
        done: item.done ? 1 : 0,
      });
    }
  }

  const categories: Array<"BUSINESS" | "ENABLER"> = ["BUSINESS", "ENABLER"];

  return {
    byType: [...types.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    byCategory: categories.map((category) => {
      const matching = items.filter((i) => i.workCategory === category);
      return {
        category,
        count: matching.length,
        points: matching.reduce((s, i) => s + points(i), 0),
        done: matching.filter((i) => i.done).length,
      };
    }),
    total: items.length,
    estimated: items.filter(isEstimated).length,
  };
}
