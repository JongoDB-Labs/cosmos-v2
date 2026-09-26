// COSMOS-150 — committing a tentative calendar event onto the PI board.
//
// The decision itself is pure, so it is pinned here rather than only through the
// calendar's DOM: which day an event sits on, whether it is still tentative, and
// which Program Increment would absorb it.
import { describe, it, expect } from "vitest";
import {
  commitState,
  eventDay,
  isTentative,
  programIncrementFor,
  type IntervalLike,
} from "./pi-commit";

const pi = (over: Partial<IntervalLike> & Pick<IntervalLike, "id">): IntervalLike => ({
  name: `PI ${over.id}`,
  intervalKind: "PROGRAM_INCREMENT",
  startDate: "2026-03-01T00:00:00.000Z",
  endDate: "2026-03-31T00:00:00.000Z",
  ...over,
});

describe("eventDay", () => {
  it("prefers the due date, the way the calendar buckets", () => {
    expect(
      eventDay({ dueDate: "2026-03-10T12:00:00.000Z", startDate: "2026-03-02T12:00:00.000Z" }),
    ).toBe("2026-03-10");
  });

  it("falls back to the start date", () => {
    expect(eventDay({ dueDate: null, startDate: "2026-03-02T12:00:00.000Z" })).toBe("2026-03-02");
  });

  it("is null for an item with no dates", () => {
    expect(eventDay({ dueDate: null, startDate: null })).toBeNull();
  });

  it("reads the calendar day in UTC, never shifting for a late-evening instant", () => {
    // The trap `src/lib/time/date-only.ts` documents: constructing a Date and
    // reading local parts lands on the 9th anywhere west of UTC.
    expect(eventDay({ dueDate: "2026-03-10T23:30:00.000Z" })).toBe("2026-03-10");
  });
});

describe("isTentative", () => {
  it("is true for a dated item that no interval owns", () => {
    expect(isTentative({ dueDate: "2026-03-10T12:00:00.000Z", intervalId: null })).toBe(true);
  });

  it("is false once an interval owns it", () => {
    expect(isTentative({ dueDate: "2026-03-10T12:00:00.000Z", intervalId: "pi1" })).toBe(false);
  });

  it("is false for an undated item — it is not on the calendar at all", () => {
    expect(isTentative({ dueDate: null, startDate: null, intervalId: null })).toBe(false);
  });
});

describe("programIncrementFor", () => {
  it("finds the PI whose range covers the day, inclusive of both ends", () => {
    const intervals = [pi({ id: "a", startDate: "2026-03-01T00:00:00.000Z", endDate: "2026-03-31T00:00:00.000Z" })];
    expect(programIncrementFor(intervals, "2026-03-01")?.id).toBe("a");
    expect(programIncrementFor(intervals, "2026-03-15")?.id).toBe("a");
    expect(programIncrementFor(intervals, "2026-03-31")?.id).toBe("a");
  });

  it("returns null for a day outside every PI", () => {
    const intervals = [pi({ id: "a" })];
    expect(programIncrementFor(intervals, "2026-02-28")).toBeNull();
    expect(programIncrementFor(intervals, "2026-04-01")).toBeNull();
  });

  it("ignores sprints — a PI board is built from PROGRAM_INCREMENT intervals only", () => {
    const sprint = pi({ id: "s1", intervalKind: "SPRINT" });
    expect(programIncrementFor([sprint], "2026-03-15")).toBeNull();
  });

  it("resolves overlapping PIs to the earliest start, whatever order they arrive in", () => {
    const early = pi({ id: "b", startDate: "2026-03-01T00:00:00.000Z", endDate: "2026-03-20T00:00:00.000Z" });
    const late = pi({ id: "a", startDate: "2026-03-10T00:00:00.000Z", endDate: "2026-03-31T00:00:00.000Z" });
    expect(programIncrementFor([late, early], "2026-03-15")?.id).toBe("b");
    expect(programIncrementFor([early, late], "2026-03-15")?.id).toBe("b");
  });
});

describe("commitState", () => {
  const intervals = [pi({ id: "pi1", name: "PI-001" })];

  it("is READY, naming the PI, for a tentative event inside one", () => {
    const state = commitState({ dueDate: "2026-03-10T12:00:00.000Z", intervalId: null }, intervals);
    expect(state).toEqual({
      kind: "READY",
      day: "2026-03-10",
      interval: intervals[0],
    });
  });

  it("is NO_PI when nothing covers the day, and says which day", () => {
    expect(commitState({ dueDate: "2026-05-04T12:00:00.000Z", intervalId: null }, intervals)).toEqual({
      kind: "NO_PI",
      day: "2026-05-04",
    });
  });

  it("is COMMITTED once the item has an interval — even one outside its dates", () => {
    expect(commitState({ dueDate: "2026-05-04T12:00:00.000Z", intervalId: "other" }, intervals)).toEqual({
      kind: "COMMITTED",
      intervalId: "other",
    });
  });

  it("is UNSCHEDULED for an undated item", () => {
    expect(commitState({ dueDate: null, startDate: null, intervalId: null }, intervals)).toEqual({
      kind: "UNSCHEDULED",
    });
  });
});
