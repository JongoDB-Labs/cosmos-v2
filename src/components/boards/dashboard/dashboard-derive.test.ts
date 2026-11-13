// The widget bag's sprint readers: velocity from each closed sprint's report,
// and the sprint spans the timeline draws.
import { describe, expect, it } from "vitest";
import type { Interval } from "@/types/models";
import { sprintSpansOf, velocityOf } from "./dashboard-derive";

const interval = (over: Partial<Interval> & { id: string; number: number }): Interval => ({
  orgId: "o",
  projectId: "p",
  intervalKind: "SPRINT",
  name: `Sprint ${over.number}`,
  goal: "",
  startDate: "2026-01-01T00:00:00.000Z",
  endDate: "2026-01-14T00:00:00.000Z",
  status: "COMPLETED",
  parentId: null,
  report: null,
  ...over,
});

describe("velocityOf", () => {
  it("reads completed and committed points from each closed sprint, oldest first", () => {
    const points = velocityOf([
      interval({ id: "b", number: 2, report: { velocity: 12, totalStoryPoints: 15 } }),
      interval({ id: "a", number: 1, report: { velocity: 8, totalStoryPoints: 10 } }),
      // Still running: no report to read, so not on the chart.
      interval({ id: "c", number: 3, status: "ACTIVE", report: null }),
    ]);
    expect(points).toEqual([
      { id: "a", name: "Sprint 1", completed: 8, committed: 10 },
      { id: "b", name: "Sprint 2", completed: 12, committed: 15 },
    ]);
  });

  it("leaves committed EMPTY on a report that never recorded it, rather than zero", () => {
    const [p] = velocityOf([
      interval({ id: "a", number: 1, report: { velocity: 5 } }),
    ]);
    expect(p.completed).toBe(5);
    expect(p.committed).toBeNull();
  });

  it("skips a closed sprint whose report has no velocity at all", () => {
    expect(velocityOf([interval({ id: "a", number: 1, report: { notes: "x" } })])).toEqual([]);
  });
});

describe("sprintSpansOf", () => {
  it("keeps sprints and leaves out the increments that contain them", () => {
    const spans = sprintSpansOf([
      interval({
        id: "pi",
        number: 1,
        intervalKind: "PROGRAM_INCREMENT",
        startDate: "2026-01-01T00:00:00.000Z",
      }),
      interval({ id: "s2", number: 2, startDate: "2026-01-15T00:00:00.000Z" }),
      interval({ id: "s1", number: 1, startDate: "2026-01-01T00:00:00.000Z" }),
    ]);
    // Positive control: sprints DO come through, in start order.
    expect(spans.map((s) => s.id)).toEqual(["s1", "s2"]);
  });
});
