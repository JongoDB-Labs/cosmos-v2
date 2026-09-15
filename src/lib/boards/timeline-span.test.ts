import { describe, it, expect } from "vitest";
import { plannedSpan, solidSpan, paintedSpan, type TimelineSpanItem } from "./timeline-span";

const TODAY = new Date("2026-03-01T00:00:00Z");

const base: TimelineSpanItem = {
  startDate: "2026-01-20T00:00:00Z",
  dueDate: "2026-02-01T00:00:00Z",
  actualStart: null,
  completedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("plannedSpan", () => {
  it("uses the planned dates when both are set", () => {
    const s = plannedSpan(base);
    expect(iso(s.start)).toBe("2026-01-20");
    expect(iso(s.end)).toBe("2026-02-01");
  });

  it("falls back to createdAt when there is no start date", () => {
    expect(iso(plannedSpan({ ...base, startDate: null }).start)).toBe("2026-01-01");
  });

  it("falls back to a week of work when there is no due date", () => {
    expect(iso(plannedSpan({ ...base, dueDate: null }).end)).toBe("2026-01-27");
  });
});

describe("solidSpan", () => {
  it("is the PLAN while nothing has actually started", () => {
    const s = solidSpan(base, TODAY);
    expect(iso(s.start)).toBe("2026-01-20");
    expect(iso(s.end)).toBe("2026-02-01");
  });

  it("is the ACTUALS once the item has started", () => {
    const s = solidSpan({ ...base, actualStart: "2026-01-05", completedAt: "2026-01-28" }, TODAY);
    expect(iso(s.start)).toBe("2026-01-05");
    expect(iso(s.end)).toBe("2026-01-28");
  });

  it("runs a started-but-unfinished item up to today", () => {
    const s = solidSpan({ ...base, actualStart: "2026-01-05" }, TODAY);
    expect(iso(s.end)).toBe("2026-03-01");
  });
});

describe("paintedSpan", () => {
  // The defect this module exists for: the axis was built from the planned
  // dates alone, so an item that began before anything was planned was laid out
  // left of the origin and clipped away by the <svg>.
  it("reaches back to an actual start that PRECEDES the planned one", () => {
    const s = paintedSpan({ ...base, actualStart: "2026-01-05", completedAt: "2026-01-28" }, TODAY);
    expect(iso(s.start)).toBe("2026-01-05");
  });

  it("still reaches back to the PLANNED start when the item started late", () => {
    // Amber runs planned -> actual start, so the plan is the left edge here.
    const s = paintedSpan({ ...base, actualStart: "2026-01-25", completedAt: "2026-01-28" }, TODAY);
    expect(iso(s.start)).toBe("2026-01-20");
  });

  it("reaches forward to an actual end that OVERRUNS the planned one", () => {
    const s = paintedSpan({ ...base, actualStart: "2026-01-20", completedAt: "2026-02-14" }, TODAY);
    expect(iso(s.end)).toBe("2026-02-14");
  });

  it("still reaches forward to the PLANNED end when the item finished early", () => {
    const s = paintedSpan({ ...base, actualStart: "2026-01-20", completedAt: "2026-01-25" }, TODAY);
    expect(iso(s.end)).toBe("2026-02-01");
  });

  it("covers both ends at once when an item started early AND overran", () => {
    const s = paintedSpan({ ...base, actualStart: "2026-01-05", completedAt: "2026-02-14" }, TODAY);
    expect(iso(s.start)).toBe("2026-01-05");
    expect(iso(s.end)).toBe("2026-02-14");
  });

  it("is exactly the plan for an item with no actuals at all", () => {
    const s = paintedSpan(base, TODAY);
    expect(iso(s.start)).toBe("2026-01-20");
    expect(iso(s.end)).toBe("2026-02-01");
  });
});

// A milestone carries a completion and usually NO actual start, and it can land
// EITHER side of its planned date. The axis has to reach a finish that beat the
// plan, or the diamond is laid out left of the origin and clipped away — which
// looked like "milestones only show drift when they are late".
describe("paintedSpan — a recorded finish with no recorded start", () => {
  const noStart: TimelineSpanItem = {
    startDate: "2026-02-10T00:00:00Z",
    dueDate: "2026-02-10T00:00:00Z",
    actualStart: null,
    completedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
  };

  it("reaches back to a completion EARLIER than the plan", () => {
    const s = paintedSpan({ ...noStart, completedAt: "2026-02-03" }, TODAY);
    expect(iso(s.start)).toBe("2026-02-03");
  });

  it("reaches forward to a completion LATER than the plan", () => {
    const s = paintedSpan({ ...noStart, completedAt: "2026-02-17" }, TODAY);
    expect(iso(s.end)).toBe("2026-02-17");
  });

  it("covers a completion outside the plan for a SPAN too, not just a point", () => {
    const s = paintedSpan(
      { ...noStart, dueDate: "2026-02-20T00:00:00Z", completedAt: "2026-02-01" },
      TODAY,
    );
    expect(iso(s.start)).toBe("2026-02-01");
    expect(iso(s.end)).toBe("2026-02-20");
  });

  it("still leaves an untouched item on its plan alone", () => {
    const s = paintedSpan(noStart, TODAY);
    expect(iso(s.start)).toBe("2026-02-10");
    expect(iso(s.end)).toBe("2026-02-10");
  });
});
