import { DAY_MS, utcMidnight } from "./time";

/**
 * Packing a week's events into lanes.
 *
 * This is the piece that makes a month grid read as a calendar rather than a
 * list. Each week is one CSS grid: seven columns, a row for the day numbers,
 * N rows of event lanes, and a row for the "+k more" links. A multi-day event
 * is ONE element spanning `grid-column: start / span n`, which is what draws it
 * as a continuous bar instead of repeating the title in every cell it touches.
 *
 * Lanes are assigned greedily, longest-first. Longest-first matters: packing in
 * start order lets a one-day event take lane 0 on Monday and force the
 * five-day event that also covers Monday down to lane 1, where it then
 * blocks four more days. Sorting by span first keeps the long bars near the top
 * and the scattered single days underneath, which is both tidier and leaves
 * fewer events pushed into the overflow.
 */

export interface PackableEvent {
  id: string;
  startsAt: Date;
  endsAt: Date;
}

export interface PlacedEvent<T extends PackableEvent> {
  event: T;
  /** 1-based CSS grid column. */
  startCol: number;
  /** Number of columns the bar spans. */
  span: number;
  /** 0-based lane index. */
  lane: number;
  /** The event began before this week — draw the left edge as continuing. */
  continuesBefore: boolean;
  /** The event runs past this week. */
  continuesAfter: boolean;
}

export interface WeekLayout<T extends PackableEvent> {
  placed: PlacedEvent<T>[];
  /** Per weekday index (0-6), how many events did not fit in the visible lanes. */
  overflow: number[];
  /** Lanes actually used, after the visible-lane cap. */
  laneCount: number;
}

/**
 * @param weekStart UTC midnight of the week's first day.
 * @param maxLanes  Visible lanes; anything beyond becomes "+k more".
 */
export function packWeek<T extends PackableEvent>(
  events: T[],
  weekStart: Date,
  maxLanes = 3,
): WeekLayout<T> {
  const weekFrom = utcMidnight(weekStart).getTime();
  const weekTo = weekFrom + 7 * DAY_MS;

  type Span = { event: T; from: number; to: number; startCol: number; span: number };
  const spans: Span[] = [];

  for (const e of events) {
    const s = e.startsAt.getTime();
    const en = e.endsAt.getTime();
    // Half-open on both sides, matching the service's overlap test.
    if (s >= weekTo || en <= weekFrom) continue;
    const clampedFrom = Math.max(s, weekFrom);
    // `endsAt` is exclusive, so the last covered day is the one before it.
    const clampedTo = Math.min(en, weekTo);
    const startDay = Math.floor((utcMidnight(new Date(clampedFrom)).getTime() - weekFrom) / DAY_MS);
    const endDayExclusive = Math.ceil((clampedTo - weekFrom) / DAY_MS);
    const span = Math.max(1, endDayExclusive - startDay);
    spans.push({
      event: e,
      from: startDay,
      to: startDay + span,
      startCol: startDay + 1,
      span,
    });
  }

  // Longest first, then earliest, then by id so the order is stable across
  // renders — an unstable sort here makes bars jump lanes on every refetch.
  spans.sort(
    (a, b) =>
      b.span - a.span ||
      a.from - b.from ||
      (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0),
  );

  const lanes: boolean[][] = [];
  const placed: PlacedEvent<T>[] = [];
  const overflow = [0, 0, 0, 0, 0, 0, 0];

  for (const s of spans) {
    let lane = 0;
    for (;; lane++) {
      if (!lanes[lane]) lanes[lane] = new Array(7).fill(false);
      let free = true;
      for (let d = s.from; d < s.to; d++) {
        if (lanes[lane][d]) {
          free = false;
          break;
        }
      }
      if (free) break;
    }

    if (lane >= maxLanes) {
      // Does not fit: it becomes part of the overflow count on each day it
      // would have covered, so "+2 more" on a Thursday really means two more
      // things happen on Thursday.
      for (let d = s.from; d < s.to; d++) overflow[d] += 1;
      continue;
    }

    for (let d = s.from; d < s.to; d++) lanes[lane][d] = true;
    placed.push({
      event: s.event,
      startCol: s.startCol,
      span: s.span,
      lane,
      continuesBefore: s.event.startsAt.getTime() < weekFrom,
      continuesAfter: s.event.endsAt.getTime() > weekTo,
    });
  }

  return {
    placed,
    overflow,
    laneCount: Math.min(lanes.length, maxLanes),
  };
}

/** The seven UTC midnights of the week beginning `weekStart`. */
export function weekDays(weekStart: Date): Date[] {
  const base = utcMidnight(weekStart).getTime();
  return Array.from({ length: 7 }, (_, i) => new Date(base + i * DAY_MS));
}

/** The week starts covering a month grid window, as UTC midnights. */
export function weeksIn(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  for (let t = utcMidnight(from).getTime(); t < to.getTime(); t += 7 * DAY_MS) out.push(new Date(t));
  return out;
}
