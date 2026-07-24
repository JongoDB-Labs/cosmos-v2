import { describe, it, expect } from "vitest";
import { computeSprintReview, isDoneColumnKey } from "./sprint-review";

// A two-week sprint reviewed exactly at its end date.
const start = "2026-07-01T00:00:00.000Z";
const end = "2026-07-15T00:00:00.000Z";

describe("isDoneColumnKey", () => {
  it("matches done/completed/closed columns case-insensitively", () => {
    expect(isDoneColumnKey("done")).toBe(true);
    expect(isDoneColumnKey("Completed")).toBe(true);
    expect(isDoneColumnKey("CLOSED")).toBe(true);
    expect(isDoneColumnKey("in_progress")).toBe(false);
    expect(isDoneColumnKey("todo")).toBe(false);
  });
});

describe("computeSprintReview", () => {
  it("uses story points as the basis when items are estimated", () => {
    const review = computeSprintReview({
      startDate: start,
      endDate: end,
      reviewedAt: end,
      items: [
        { storyPoints: 5, columnKey: "done" },
        { storyPoints: 3, columnKey: "done" },
        { storyPoints: 2, columnKey: "in_progress" },
      ],
    });
    expect(review.basis).toBe("points");
    expect(review.totalPoints).toBe(10);
    expect(review.completedPoints).toBe(8);
    expect(review.completedItems).toBe(2);
    expect(review.incompleteItems).toBe(1);
    // 8 of 10 committed points.
    expect(review.efficiency).toBe(80);
    // 8 points over 14 elapsed days.
    expect(review.burnRate).toBeCloseTo(0.6, 1);
  });

  it("falls back to item counts when nothing is estimated", () => {
    const review = computeSprintReview({
      startDate: start,
      endDate: end,
      reviewedAt: end,
      items: [
        { storyPoints: null, columnKey: "done" },
        { storyPoints: null, columnKey: "todo" },
      ],
    });
    expect(review.basis).toBe("items");
    expect(review.efficiency).toBe(50);
  });

  it("reports 'behind' when completion trails the ideal burndown at sprint end", () => {
    const review = computeSprintReview({
      startDate: start,
      endDate: end,
      reviewedAt: end,
      items: [
        { storyPoints: 4, columnKey: "done" },
        { storyPoints: 6, columnKey: "in_progress" },
      ],
    });
    // At sprint end the whole commitment was due; 40% done → behind.
    expect(review.pacing).toBeCloseTo(0.4, 2);
    expect(review.pacingStatus).toBe("behind");
  });

  it("reports 'ahead' when a sprint finishes everything early", () => {
    const halfway = "2026-07-08T00:00:00.000Z"; // ~7 of 14 days in
    const review = computeSprintReview({
      startDate: start,
      endDate: end,
      reviewedAt: halfway,
      items: [
        { storyPoints: 5, columnKey: "done" },
        { storyPoints: 5, columnKey: "done" },
      ],
    });
    // Everything done at the halfway mark → well ahead of the ideal line.
    expect(review.pacingStatus).toBe("ahead");
    expect(review.pacing).toBeGreaterThan(1.05);
  });

  it("is well-behaved for an empty sprint", () => {
    const review = computeSprintReview({
      startDate: start,
      endDate: end,
      reviewedAt: end,
      items: [],
    });
    expect(review.basis).toBe("items");
    expect(review.efficiency).toBe(0);
    expect(review.burnRate).toBe(0);
    expect(review.pacingStatus).toBe("on track");
  });
});
