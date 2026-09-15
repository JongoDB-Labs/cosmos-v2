// @vitest-environment node
//
// Burndown, and the four ways a burndown chart lies.
//
// A chart is read as fact, and these tests exist mostly to pin REFUSALS: not
// drawing the future, not backdating work whose date is unknown, not burning
// down across weekends, and not treating a reopened item as delivered.
import { describe, it, expect } from "vitest";
import { burndown, dayKey, type BurndownItemLike } from "./burndown";

/** Mon 2026-08-03 → Fri 2026-08-14: a 2-week sprint with one full weekend. */
const START = new Date(2026, 7, 3);
const END = new Date(2026, 7, 14);

const item = (over: Partial<BurndownItemLike> & { id: string }): BurndownItemLike => ({
  storyPoints: null,
  completedAt: null,
  done: false,
  ...over,
});

describe("burndown — what it refuses to draw", () => {
  it("draws NO remaining line past today, because that would be a forecast", () => {
    const s = burndown({
      start: START,
      end: END,
      today: new Date(2026, 7, 5), // Wednesday, mid-sprint
      items: [item({ id: "a" }), item({ id: "b" })],
    });

    const past = s.points.filter((p) => !p.isFuture);
    const future = s.points.filter((p) => p.isFuture);

    expect(past.length).toBeGreaterThan(0);
    expect(future.length).toBeGreaterThan(0);
    expect(past.every((p) => p.remaining !== null)).toBe(true);
    // The whole point: a flat line to the sprint end reads as "on target".
    expect(future.every((p) => p.remaining === null && p.completed === null)).toBe(true);
    // The ideal DOES continue — it is a plan, not an observation.
    expect(future.every((p) => typeof p.ideal === "number")).toBe(true);
  });

  it("attributes a done-but-undated item to TODAY, never to day zero", () => {
    const s = burndown({
      start: START,
      end: END,
      today: new Date(2026, 7, 5),
      items: [item({ id: "a", done: true, completedAt: null })],
    });

    expect(s.undatedCompletions).toBe(1);
    // Day one must still show the full scope outstanding — backdating would
    // invent progress on a day nothing was known to happen.
    const first = s.points[0];
    expect(first.remaining).toBe(1);
    expect(first.completed).toBe(0);
    // …and it lands on today.
    const todayPoint = s.points.find((p) => p.isToday);
    expect(todayPoint?.completed).toBe(1);
    expect(todayPoint?.remaining).toBe(0);
  });

  it("does NOT burn down across a weekend — the ideal is flat Sat and Sun", () => {
    const s = burndown({
      start: START,
      end: END,
      today: END,
      items: Array.from({ length: 10 }, (_, i) => item({ id: `i${i}` })),
    });

    const sat = s.points.find((p) => p.date === "2026-08-08");
    const sun = s.points.find((p) => p.date === "2026-08-09");
    const fri = s.points.find((p) => p.date === "2026-08-07");
    expect(sat?.isWeekend).toBe(true);
    expect(sun?.isWeekend).toBe(true);
    expect(sat?.ideal).toBe(fri?.ideal);
    expect(sun?.ideal).toBe(fri?.ideal);
    // 10 working days in this range, so the ideal reaches zero exactly at the end.
    expect(s.workingDays).toBe(10);
    expect(s.points[s.points.length - 1].ideal).toBe(0);
  });

  it("treats a REOPENED item as outstanding even though it has a completion date", () => {
    // `done` is the authority on whether it is finished; `completedAt` only on
    // when. Trusting the stale date would quietly delete the work.
    const s = burndown({
      start: START,
      end: END,
      today: new Date(2026, 7, 5),
      items: [item({ id: "a", done: false, completedAt: new Date(2026, 7, 4) })],
    });
    expect(s.completed).toBe(0);
    expect(s.remaining).toBe(1);
    expect(s.undatedCompletions).toBe(0);
  });
});

describe("burndown — the numbers themselves", () => {
  it("burns down on the day the work actually finished", () => {
    const s = burndown({
      start: START,
      end: END,
      today: new Date(2026, 7, 6),
      items: [
        item({ id: "a", done: true, completedAt: new Date(2026, 7, 4) }),
        item({ id: "b", done: true, completedAt: new Date(2026, 7, 6) }),
        item({ id: "c" }),
      ],
    });

    const byDate = Object.fromEntries(s.points.map((p) => [p.date, p]));
    expect(byDate["2026-08-03"].remaining).toBe(3); // nothing done yet
    expect(byDate["2026-08-04"].remaining).toBe(2);
    expect(byDate["2026-08-05"].remaining).toBe(2); // nothing finished that day
    expect(byDate["2026-08-06"].remaining).toBe(1);
    expect(s.scope).toBe(3);
    expect(s.completed).toBe(2);
    expect(s.remaining).toBe(1);
  });

  it("weights by story points when asked, ignoring unestimated items", () => {
    const s = burndown({
      start: START,
      end: END,
      today: new Date(2026, 7, 6),
      unit: "points",
      items: [
        item({ id: "a", storyPoints: 5, done: true, completedAt: new Date(2026, 7, 4) }),
        item({ id: "b", storyPoints: 3 }),
        item({ id: "c", storyPoints: null }), // unestimated contributes 0
      ],
    });
    expect(s.scope).toBe(8);
    expect(s.completed).toBe(5);
    expect(s.remaining).toBe(3);
    // Coverage is reported so the UI can warn that a third of the items are
    // invisible on a points chart.
    expect(s.pointsCoverage).toEqual({ estimated: 2, total: 3 });
  });

  it("an empty interval is zeros, not NaN — the normal state before planning", () => {
    const s = burndown({ start: START, end: END, today: START, items: [] });
    expect(s.scope).toBe(0);
    expect(s.points.every((p) => Number.isFinite(p.ideal))).toBe(true);
    expect(s.points[0].remaining).toBe(0);
  });

  it("refuses an inverted date range instead of looping", () => {
    const s = burndown({ start: END, end: START, today: START, items: [item({ id: "a" })] });
    expect(s.points).toEqual([]);
  });
});

describe("dayKey", () => {
  it("uses the LOCAL calendar day, not UTC — the day the reader is looking at", () => {
    // 23:30 local on the 3rd is still the 3rd, even though it is the 4th in UTC
    // for anyone east of the meridian. Getting this wrong is how time entries
    // showed up on the wrong day.
    expect(dayKey(new Date(2026, 7, 3, 23, 30))).toBe("2026-08-03");
    expect(dayKey(new Date(2026, 7, 3, 0, 15))).toBe("2026-08-03");
  });
});
