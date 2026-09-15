import { describe, it, expect } from "vitest";
import { buildIntervalReport } from "./interval-report";

const completedAt = "2026-08-11T12:00:00.000Z";

/**
 * Completing a sprint reassigns `intervalId` on every unfinished item, so the
 * finished sprint stops owning them. Anything derived from "items on this
 * sprint that are not done" therefore reads EMPTY the moment the sprint closes
 * — including the review board's "What we're carrying forward".
 *
 * The report is the only place that fact survives, so these tests pin it.
 */

const items = [
  { id: "a", columnKey: "done", storyPoints: 8, priority: "HIGH" },
  { id: "b", columnKey: "done", storyPoints: 5, priority: "HIGH" },
  { id: "c", columnKey: "in_review", storyPoints: 3, priority: "MEDIUM" },
  { id: "d", columnKey: "todo", storyPoints: null, priority: "LOW" },
];

describe("buildIntervalReport", () => {
  it("names the items that carried, so the list survives their reassignment", () => {
    const report = buildIntervalReport(items, completedAt);
    expect(report.carriedItemIds).toEqual(["c", "d"]);
  });

  it("records no carried items when everything shipped", () => {
    const report = buildIntervalReport(
      [{ id: "a", columnKey: "done", storyPoints: 1, priority: "LOW" }],
      completedAt
    );
    expect(report.carriedItemIds).toEqual([]);
  });

  it("counts completion the same way the review does", () => {
    // A second definition of "done" would let the report and the board disagree.
    const report = buildIntervalReport(items, completedAt);
    expect(report.totalItems).toBe(4);
    expect(report.completedItems).toBe(2);
    expect(report.incompleteItems).toBe(2);
  });

  it("sums points across all items and across completed ones", () => {
    const report = buildIntervalReport(items, completedAt);
    expect(report.totalStoryPoints).toBe(16);
    expect(report.completedStoryPoints).toBe(13);
    // Velocity is what the team actually delivered, not what it committed to.
    expect(report.velocity).toBe(13);
  });

  it("keeps the priority breakdown the previous report shape carried", () => {
    const report = buildIntervalReport(items, completedAt);
    expect(report.itemsByPriority).toEqual({ HIGH: 2, MEDIUM: 1, LOW: 1 });
  });

  it("stamps the completion time it was given rather than reading the clock", () => {
    // Pure: the route supplies the instant, so the report is reproducible.
    expect(buildIntervalReport(items, completedAt).completedAt).toBe(completedAt);
  });
});
