import { dateOnlyKey } from "@/lib/time/date-only";

/**
 * Committing a tentative calendar event onto the PI board.
 *
 * ## What "tentative" and "committed" mean here
 *
 * A planning calendar shows work items by date. An item can carry dates long
 * before anyone has agreed which Program Increment will actually absorb it —
 * that is the pencilled-in, "tentative" state the request is about. The item is
 * on the calendar, but no PI owns it, so it appears on no PI board.
 *
 * There is no separate `tentative` flag and deliberately so: the codebase
 * already answers "which PI owns this item" with `WorkItem.intervalId`, and a
 * second column saying the same thing in different words is a drift waiting to
 * happen. So:
 *
 *   tentative  = has a calendar date, `intervalId` is null
 *   committed  = `intervalId` points at an interval
 *
 * ## What commit does
 *
 * It moves the event onto the PI board that covers its dates — i.e. it sets
 * `intervalId` to the PROGRAM_INCREMENT interval whose range contains the
 * event's day, leaving the dates untouched. Nothing else: no planning
 * milestones, no AAR tasks, no template expansion. (That was an open question
 * on the ticket; this is the decision that shipped, and it is reversible by
 * clearing the interval again.)
 *
 * ## Dates are compared as CALENDAR DAYS
 *
 * Via `dateOnlyKey`, the rule this repo already uses: take the `YYYY-MM-DD`
 * prefix and never build a `Date` from the full instant. ISO date strings sort
 * lexicographically, so a range test is a pair of string comparisons and cannot
 * drift a day for a reader west of UTC — which is the exact class of bug
 * `src/lib/time/date-only.ts` exists to document.
 */

/** The `IntervalKind` a PI board is built from. */
export const PROGRAM_INCREMENT_KIND = "PROGRAM_INCREMENT";

/** The bits of a work item this decision reads. */
export interface CalendarEventLike {
  intervalId?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
}

/** The bits of an interval this decision reads. */
export interface IntervalLike {
  id: string;
  name: string;
  intervalKind: string;
  startDate: string;
  endDate: string;
}

/**
 * The day the calendar draws this event on: its due date, falling back to its
 * start — the same precedence `calendar-view` buckets by. Null when the item
 * carries no date at all and so is not on the calendar.
 */
export function eventDay(item: CalendarEventLike): string | null {
  const raw = item.dueDate ?? item.startDate;
  return raw ? dateOnlyKey(raw) : null;
}

/** Scheduled on the calendar, but no PI owns it yet. */
export function isTentative(item: CalendarEventLike): boolean {
  return !item.intervalId && eventDay(item) !== null;
}

/**
 * The Program Increment whose range covers `day`, or null when none does.
 *
 * Ties (overlapping PIs, which nothing forbids) resolve to the one that starts
 * earliest, then to the lowest id — an arbitrary rule, but a STABLE one, so the
 * button's target does not depend on the order the API happened to return.
 */
export function programIncrementFor(
  intervals: readonly IntervalLike[],
  day: string,
): IntervalLike | null {
  const covering = intervals.filter(
    (i) =>
      i.intervalKind === PROGRAM_INCREMENT_KIND &&
      dateOnlyKey(i.startDate) <= day &&
      day <= dateOnlyKey(i.endDate),
  );
  if (covering.length === 0) return null;
  return [...covering].sort(
    (a, b) => dateOnlyKey(a.startDate).localeCompare(dateOnlyKey(b.startDate)) || a.id.localeCompare(b.id),
  )[0];
}

/**
 * What the Commit control should do for one event — resolved once, here, so the
 * view renders a decision rather than making one.
 */
export type CommitState =
  /** Already on a PI board (or in a sprint); nothing to commit. */
  | { kind: "COMMITTED"; intervalId: string }
  /** No dates, so there is nothing to move over. */
  | { kind: "UNSCHEDULED" }
  /** Tentative, and a PI covers its day. */
  | { kind: "READY"; day: string; interval: IntervalLike }
  /** Tentative, but no PI covers its day — commit would have nowhere to land. */
  | { kind: "NO_PI"; day: string };

export function commitState(
  item: CalendarEventLike,
  intervals: readonly IntervalLike[],
): CommitState {
  if (item.intervalId) return { kind: "COMMITTED", intervalId: item.intervalId };
  const day = eventDay(item);
  if (!day) return { kind: "UNSCHEDULED" };
  const interval = programIncrementFor(intervals, day);
  return interval ? { kind: "READY", day, interval } : { kind: "NO_PI", day };
}
