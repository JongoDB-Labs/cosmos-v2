/**
 * Scope change and commitment-vs-completed, per interval.
 *
 * WHY THIS IS THE PANEL STAKEHOLDERS ACTUALLY WANT. Every other number on Sprint
 * Health describes the sprint as it stands now. None of them answers "is this the
 * sprint we planned?" — and a team that finishes 90% of a sprint it doubled
 * halfway through is in a completely different position from one that finished
 * 90% of what it committed to. `activities` has recorded every `intervalId`
 * change all along; nothing displayed it.
 *
 * THE RULE THAT MAKES OR BREAKS THIS: **a move before the interval STARTS is
 * planning, not churn.** Grooming a backlog into next sprint is the process
 * working. Counting it as "scope added" would make every well-planned sprint
 * look chaotic and would drown the signal — the handful of mid-sprint injections
 * that actually cost the team something. Only movements at or after `startDate`
 * count.
 *
 * WHAT "COMMITTED" MEANS HERE. It is reconstructed, not stored: the membership
 * at sprint start = what is in the interval now, minus everything added since it
 * started, plus everything removed since it started. That is exact when the
 * activity log is complete and drifts only if history was deleted. It is
 * reported alongside the reconstruction inputs so a reader can see how it was
 * derived rather than trusting a bare number.
 */

export interface IntervalChange {
  workItemId: string;
  /** Interval the item left, or null when it came from the backlog. */
  from: string | null;
  /** Interval the item joined, or null when it went back to the backlog. */
  to: string | null;
  at: string | Date;
}

export interface ScopeIntervalLike {
  id: string;
  name: string;
  startDate: string | Date;
  endDate: string | Date;
  status: string;
}

export interface ScopeItemLike {
  id: string;
  intervalId: string | null;
  done: boolean;
}

export interface ScopeChangeRow {
  intervalId: string;
  name: string;
  /** Items pulled in AFTER the interval started. */
  added: number;
  /** Items pushed out AFTER the interval started. */
  removed: number;
  /** Reconstructed membership at the moment the interval started. */
  committed: number;
  /** In the interval now. */
  current: number;
  /** Of the current members, how many are finished. */
  completed: number;
  /**
   * completed / committed as a percentage, or null when nothing was committed —
   * finishing 3 of 0 is not 300% delivery, it is a sprint that was empty at
   * planning and filled later, which the added count already tells you.
   */
  commitmentKept: number | null;
  /** added + removed, as a share of what was committed. Null when committed is 0. */
  churnRate: number | null;
}

function parseDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Per-interval scope movement and commitment, oldest interval first.
 *
 * `changes` may cover any span; movements outside an interval's window are
 * ignored for that interval rather than filtered by the caller, so a caller
 * cannot accidentally narrow the window and under-report churn.
 */
export function scopeChange(
  changes: readonly IntervalChange[],
  intervals: readonly ScopeIntervalLike[],
  items: readonly ScopeItemLike[],
): ScopeChangeRow[] {
  const byInterval = new Map<string, ScopeItemLike[]>();
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
      const start = parseDate(interval.startDate);
      const members = byInterval.get(interval.id) ?? [];

      // A move BEFORE the sprint starts is planning. Only count from the start.
      const inWindow = changes.filter((c) => {
        const at = parseDate(c.at);
        return at !== null && start !== null && at >= start;
      });

      // NET effect per item, not a count of events. An item yo-yoing in and out
      // of the same sprint is one disruption to that team, not four, and
      // counting events lets a single indecisive ticket dominate the chart.
      //
      // The net is decided by where the item sat BEFORE its first move in this
      // window versus AFTER its last — which is why this cannot be done by
      // cancelling an "added" set against a "removed" set. Out-then-back-in is
      // no change; in-out-in ends inside having started outside, so it IS an
      // addition, and set cancellation silently scores that as nothing.
      const perItem = new Map<string, IntervalChange[]>();
      for (const c of inWindow) {
        // Moves between two other intervals say nothing about this one.
        if (c.from !== interval.id && c.to !== interval.id) continue;
        const list = perItem.get(c.workItemId);
        if (list) list.push(c);
        else perItem.set(c.workItemId, [c]);
      }

      let added = 0;
      let removed = 0;
      for (const moves of perItem.values()) {
        moves.sort((a, b) => (parseDate(a.at)?.getTime() ?? 0) - (parseDate(b.at)?.getTime() ?? 0));
        const wasIn = moves[0].from === interval.id;
        const isIn = moves[moves.length - 1].to === interval.id;
        if (!wasIn && isIn) added += 1;
        else if (wasIn && !isIn) removed += 1;
      }
      const current = members.length;
      const completed = members.filter((m) => m.done).length;
      // Reconstructed: what is here now, minus what arrived late, plus what left.
      const committed = Math.max(0, current - added + removed);

      return {
        intervalId: interval.id,
        name: interval.name,
        added,
        removed,
        committed,
        current,
        completed,
        commitmentKept: committed > 0 ? (completed / committed) * 100 : null,
        churnRate: committed > 0 ? ((added + removed) / committed) * 100 : null,
      };
    });
}

// ---------------------------------------------------------------------------
// Carryover
// ---------------------------------------------------------------------------

export interface CarryoverRow {
  intervalId: string;
  name: string;
  /** Items that arrived here from an EARLIER interval — work the team inherited. */
  carriedIn: number;
  /** Items that left here for a LATER one — work this sprint did not finish. */
  carriedOut: number;
}

export interface CarryoverResult {
  rows: CarryoverRow[];
  /**
   * Items that have been carried more than once. These are the ones worth a
   * conversation: a single slip is a sprint that ran long, the same ticket
   * slipping four times is something nobody is actually working on.
   */
  repeatOffenders: Array<{ workItemId: string; hops: number }>;
}

/**
 * What rolls from one interval into the next.
 *
 * A move BACK to the backlog is not carryover — it is descoping, which
 * `scopeChange` already reports as `removed`. Carryover is specifically
 * sprint-to-sprint: work that stayed committed but did not get done, and became
 * the next sprint's problem. Conflating the two would flatter a team that keeps
 * dropping work and punish one that keeps honouring it.
 *
 * Direction is decided by the intervals' start dates rather than by which is
 * "next", so a move into an EARLIER sprint (a correction) is not counted as
 * carryover in either direction.
 */
export function carryover(
  changes: readonly IntervalChange[],
  intervals: readonly ScopeIntervalLike[],
): CarryoverResult {
  const startOf = new Map(intervals.map((i) => [i.id, new Date(i.startDate).getTime()]));

  const rows = new Map<string, CarryoverRow>(
    intervals
      .slice()
      .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime())
      .map((i) => [i.id, { intervalId: i.id, name: i.name, carriedIn: 0, carriedOut: 0 }]),
  );

  const hops = new Map<string, number>();

  for (const c of changes) {
    // Both ends must be intervals we know about: backlog moves are descoping,
    // and an unknown interval cannot be placed in time.
    if (!c.from || !c.to) continue;
    const fromStart = startOf.get(c.from);
    const toStart = startOf.get(c.to);
    if (fromStart === undefined || toStart === undefined) continue;
    // Forwards only. A move into an earlier sprint is a correction, not a slip.
    if (toStart <= fromStart) continue;

    rows.get(c.from)!.carriedOut += 1;
    rows.get(c.to)!.carriedIn += 1;
    hops.set(c.workItemId, (hops.get(c.workItemId) ?? 0) + 1);
  }

  return {
    rows: [...rows.values()],
    repeatOffenders: [...hops.entries()]
      .filter(([, n]) => n > 1)
      .map(([workItemId, n]) => ({ workItemId, hops: n }))
      .sort((a, b) => b.hops - a.hops),
  };
}

// ---------------------------------------------------------------------------
// Predictability
// ---------------------------------------------------------------------------

/**
 * Closed intervals required before predictability means anything.
 *
 * Predictability is a claim about SPREAD, and spread is dominated by whichever
 * sprint had a holiday in it until there are enough samples to drown that out.
 * Five is the figure the panel registry already carries, and the same reasoning
 * that put a 3-sprint floor on throughput variation applies harder here: this
 * number gets quoted at people.
 */
export const MIN_PREDICTABILITY_SAMPLES = 5;

export interface Predictability {
  /** Mean commitment kept, as a percentage, across closed intervals. */
  mean: number | null;
  /** Spread of commitment kept. Null below the sample floor. */
  stdDev: number | null;
  /** Closed intervals that had something committed to measure against. */
  samples: number;
  /** What it still needs, when it cannot yet report. Null once it can. */
  shortfall: { needs: number; has: number } | null;
}

/**
 * How reliably the team delivers what it forecast.
 *
 * Built from `scopeChange` rather than from velocity: hitting the same point
 * total every sprint while finishing a different half of what was promised is
 * consistency, not predictability, and only the commitment figure can tell
 * those apart.
 *
 * Intervals where nothing was committed are EXCLUDED rather than scored zero.
 * A sprint that was empty at planning and filled later says nothing about
 * whether this team keeps its word.
 */
export function predictability(
  rows: readonly ScopeChangeRow[],
  closedIntervalIds: ReadonlySet<string>,
): Predictability {
  const kept = rows
    .filter((r) => closedIntervalIds.has(r.intervalId) && r.commitmentKept !== null)
    .map((r) => r.commitmentKept as number);

  if (kept.length < MIN_PREDICTABILITY_SAMPLES) {
    return {
      mean: null,
      stdDev: null,
      samples: kept.length,
      shortfall: { needs: MIN_PREDICTABILITY_SAMPLES, has: kept.length },
    };
  }

  const mean = kept.reduce((s, k) => s + k, 0) / kept.length;
  const variance = kept.reduce((s, k) => s + (k - mean) ** 2, 0) / kept.length;

  return { mean, stdDev: Math.sqrt(variance), samples: kept.length, shortfall: null };
}
