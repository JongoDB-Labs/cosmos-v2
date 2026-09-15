import { describe, it, expect } from "vitest";
import { isWorkItemDone, type DoneStateColumn } from "./done-state";

/**
 * BR: "the strike through should occur if the child ticket is in the done column
 * or the actual end date is set for the child ticket."
 *
 * Every case below is a keep/drop PAIR — the done assertion and the not-done
 * assertion for the same signal. A one-sided test here would pass against a
 * predicate hardwired to `true`, which is precisely the shape of vacuity that
 * makes a green test worse than no test.
 */

const COLUMNS: DoneStateColumn[] = [
  { key: "backlog", category: "TODO" },
  { key: "doing", category: "IN_PROGRESS" },
  { key: "shipped", category: "DONE" },
  { key: "dropped", category: "CANCELLED" },
];

describe("isWorkItemDone — the actual-end-date signal", () => {
  it("is done when completedAt is set, whatever column it sits in", () => {
    expect(
      isWorkItemDone({ columnKey: "backlog", completedAt: "2026-09-01T00:00:00Z" }, COLUMNS),
    ).toBe(true);
  });

  it("is NOT done when completedAt is null and the column is not done", () => {
    expect(isWorkItemDone({ columnKey: "backlog", completedAt: null }, COLUMNS)).toBe(false);
  });

  it("accepts a Date as well as an ISO string", () => {
    expect(isWorkItemDone({ columnKey: "doing", completedAt: new Date() }, COLUMNS)).toBe(true);
  });

  it("treats a missing completedAt key the same as null", () => {
    expect(isWorkItemDone({ columnKey: "doing" }, COLUMNS)).toBe(false);
  });
});

describe("isWorkItemDone — the done-column signal", () => {
  it("is done in a DONE-category column with no end date", () => {
    expect(isWorkItemDone({ columnKey: "shipped", completedAt: null }, COLUMNS)).toBe(true);
  });

  it("is NOT done in an IN_PROGRESS column", () => {
    expect(isWorkItemDone({ columnKey: "doing", completedAt: null }, COLUMNS)).toBe(false);
  });

  it("is NOT done in a CANCELLED column — abandoning work is not finishing it", () => {
    // Mirrors the reasoning already recorded in lib/boards/column-phase.ts:
    // stamping a cancelled item as complete would report it as delivered.
    expect(isWorkItemDone({ columnKey: "dropped", completedAt: null }, COLUMNS)).toBe(false);
  });

  it("believes the CATEGORY over the column's name", () => {
    // A team may name a lane "Done" and re-categorise it. The category is the
    // source of truth whenever the column is known.
    const relabelled: DoneStateColumn[] = [{ key: "done", category: "IN_PROGRESS" }];
    expect(isWorkItemDone({ columnKey: "done", completedAt: null }, relabelled)).toBe(false);
  });
});

describe("isWorkItemDone — boards that own no columns", () => {
  // board.columns is EMPTY on Timeline / Roadmap / Calendar / Table: creation
  // seeds no columns for those types. A predicate that needed the column list
  // would report "nothing is done" on every one of them.
  it("still honours the end date with no columns at all", () => {
    expect(isWorkItemDone({ columnKey: "whatever", completedAt: "2026-09-01" }, [])).toBe(true);
    expect(isWorkItemDone({ columnKey: "whatever", completedAt: "2026-09-01" })).toBe(true);
  });

  it("falls back to the canonical 'done' key ONLY when the column is unknown", () => {
    expect(isWorkItemDone({ columnKey: "done", completedAt: null }, [])).toBe(true);
    expect(isWorkItemDone({ columnKey: "Done", completedAt: null }, [])).toBe(true);
  });

  it("does not treat every unknown column as done", () => {
    // The positive control for the clause above: without this, a fallback of
    // `return true` would pass the previous test.
    expect(isWorkItemDone({ columnKey: "in-review", completedAt: null }, [])).toBe(false);
    expect(isWorkItemDone({ columnKey: "completed", completedAt: null }, [])).toBe(false);
  });

  it("is not done with no column and no end date", () => {
    expect(isWorkItemDone({}, COLUMNS)).toBe(false);
    expect(isWorkItemDone({ columnKey: null, completedAt: null }, COLUMNS)).toBe(false);
  });
});
