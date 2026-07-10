import { describe, it, expect } from "vitest";
import {
  isDoneColumn,
  computeSprintMetrics,
  incrementSprintName,
  suggestNextSprint,
} from "./sprint-metrics";

describe("isDoneColumn", () => {
  it("matches done/completed/closed regardless of case or affixes", () => {
    expect(isDoneColumn("done")).toBe(true);
    expect(isDoneColumn("Done")).toBe(true);
    expect(isDoneColumn("completed")).toBe(true);
    expect(isDoneColumn("col_closed")).toBe(true);
    expect(isDoneColumn("in_progress")).toBe(false);
    expect(isDoneColumn("todo")).toBe(false);
  });
});

describe("computeSprintMetrics", () => {
  const start = "2026-01-01T00:00:00.000Z";
  const end = "2026-01-11T00:00:00.000Z"; // 10-day sprint

  it("splits done vs incomplete items and sums story points (velocity)", () => {
    const m = computeSprintMetrics({
      startDate: start,
      endDate: end,
      asOf: new Date("2026-01-06T00:00:00.000Z"), // halfway
      items: [
        { columnKey: "done", storyPoints: 3, priority: "HIGH" },
        { columnKey: "done", storyPoints: 2, priority: "LOW" },
        { columnKey: "in_progress", storyPoints: 5, priority: "HIGH" },
        { columnKey: "todo", storyPoints: null, priority: "MEDIUM" },
      ],
    });

    expect(m.totalItems).toBe(4);
    expect(m.completedItems).toBe(2);
    expect(m.incompleteItems).toBe(2);
    expect(m.totalStoryPoints).toBe(10);
    expect(m.completedStoryPoints).toBe(5);
    expect(m.velocity).toBe(5);
    expect(m.itemCompletionRate).toBe(0.5);
    expect(m.pointCompletionRate).toBe(0.5);
    expect(m.itemsByPriority).toEqual({ HIGH: 2, LOW: 1, MEDIUM: 1 });
  });

  it("computes elapsed/burn/pacing halfway through an even-paced sprint as on-track", () => {
    const m = computeSprintMetrics({
      startDate: start,
      endDate: end,
      asOf: new Date("2026-01-06T00:00:00.000Z"), // 5 of 10 days
      items: [
        { columnKey: "done", storyPoints: 5 },
        { columnKey: "todo", storyPoints: 5 },
      ],
    });

    expect(m.totalDays).toBe(10);
    expect(m.elapsedDays).toBe(5);
    expect(m.remainingDays).toBe(5);
    expect(m.idealBurnRate).toBe(1); // 10 pts / 10 days
    expect(m.burnRate).toBe(1); // 5 pts / 5 days
    expect(m.expectedCompletedByNow).toBe(5);
    expect(m.pacingDelta).toBe(0);
    expect(m.pacing).toBe("on-track");
    expect(m.requiredBurnRate).toBe(1); // 5 remaining / 5 days
  });

  it("flags a sprint that is behind schedule", () => {
    const m = computeSprintMetrics({
      startDate: start,
      endDate: end,
      asOf: new Date("2026-01-09T00:00:00.000Z"), // 8 of 10 days
      items: [
        { columnKey: "done", storyPoints: 2 },
        { columnKey: "todo", storyPoints: 8 },
      ],
    });
    // expected ~8 pts by day 8, only 2 done → behind
    expect(m.pacing).toBe("behind");
    expect(m.pacingDelta).toBeLessThan(0);
    expect(m.requiredBurnRate).toBe(4); // 8 remaining / 2 days left
  });

  it("flags a sprint that is ahead of schedule", () => {
    const m = computeSprintMetrics({
      startDate: start,
      endDate: end,
      asOf: new Date("2026-01-03T00:00:00.000Z"), // 2 of 10 days
      items: [
        { columnKey: "done", storyPoints: 6 },
        { columnKey: "todo", storyPoints: 4 },
      ],
    });
    expect(m.pacing).toBe("ahead");
    expect(m.pacingDelta).toBeGreaterThan(0);
  });

  it("never divides by zero for an empty or zero-length sprint", () => {
    const m = computeSprintMetrics({
      startDate: start,
      endDate: start, // zero-length
      asOf: new Date(start),
      items: [],
    });
    expect(m.totalItems).toBe(0);
    expect(m.itemCompletionRate).toBe(0);
    expect(m.pointCompletionRate).toBe(0);
    expect(m.burnRate).toBe(0);
    expect(m.idealBurnRate).toBe(0);
    expect(m.requiredBurnRate).toBe(0);
    expect(m.pacing).toBe("on-track");
  });

  it("clamps elapsed days to the sprint length when evaluated after it ends", () => {
    const m = computeSprintMetrics({
      startDate: start,
      endDate: end,
      asOf: new Date("2026-02-01T00:00:00.000Z"), // well past the end
      items: [{ columnKey: "done", storyPoints: 10 }],
    });
    expect(m.elapsedDays).toBe(10);
    expect(m.remainingDays).toBe(0);
    expect(m.burnRate).toBe(1); // 10 pts over the full 10 days
  });
});

describe("incrementSprintName", () => {
  it("increments a trailing iteration number", () => {
    expect(incrementSprintName("Sprint 1")).toBe("Sprint 2");
    expect(incrementSprintName("Sprint 9")).toBe("Sprint 10");
    expect(incrementSprintName("Two-week Sprint 12")).toBe("Two-week Sprint 13");
  });

  it("keeps trailing punctuation after the number", () => {
    expect(incrementSprintName("Sprint 3 (Q1)")).toBe("Sprint 3 (Q2)");
  });

  it("appends 2 when there is no number", () => {
    expect(incrementSprintName("Hardening")).toBe("Hardening 2");
  });
});

describe("suggestNextSprint", () => {
  it("keeps the same duration, starts the day after, and increments the name", () => {
    const next = suggestNextSprint({
      name: "Sprint 1",
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-01-14T00:00:00.000Z", // 13-day span
      cycleKind: "SPRINT",
      parentId: null,
    });

    expect(next.name).toBe("Sprint 2");
    expect(next.durationDays).toBe(13);
    expect(next.startDate).toBe("2026-01-15T00:00:00.000Z"); // day after prior end
    expect(next.endDate).toBe("2026-01-28T00:00:00.000Z"); // same 13-day span
    expect(next.cycleKind).toBe("SPRINT");
    expect(next.parentId).toBeNull();
  });

  it("carries the cycle kind and parent PI forward", () => {
    const next = suggestNextSprint({
      name: "Iteration 4",
      startDate: "2026-03-01T00:00:00.000Z",
      endDate: "2026-03-15T00:00:00.000Z",
      cycleKind: "ITERATION",
      parentId: "pi-123",
    });
    expect(next.name).toBe("Iteration 5");
    expect(next.cycleKind).toBe("ITERATION");
    expect(next.parentId).toBe("pi-123");
  });
});
