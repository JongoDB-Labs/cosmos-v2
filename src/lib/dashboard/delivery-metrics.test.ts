// @vitest-environment node
//
// The tests that matter here are the ones proving these metrics refuse to
// flatter. Any implementation computes a median; the question is what it does
// with the items it cannot measure, the sprint that is only half over, and the
// row whose completion precedes its start.
import { describe, it, expect } from "vitest";
import {
  cycleTime,
  throughput,
  throughputSummary,
  workTypeMix,
  type DeliveryItemLike,
  type ThroughputInterval,
} from "./delivery-metrics";

function item(over: Partial<DeliveryItemLike> = {}): DeliveryItemLike {
  return {
    id: Math.random().toString(36).slice(2),
    intervalId: "s1",
    storyPoints: null,
    actualStart: null,
    completedAt: null,
    done: false,
    typeKey: "story",
    typeName: "Story",
    typeColor: "#3b82f6",
    workCategory: "BUSINESS",
    ...over,
  };
}

/** An item that started `days` before it finished, finishing at a fixed instant. */
function tookDays(days: number, over: Partial<DeliveryItemLike> = {}): DeliveryItemLike {
  const end = new Date("2026-03-10T12:00:00Z");
  const start = new Date(end.getTime() - days * 86_400_000);
  return item({ done: true, actualStart: start, completedAt: end, ...over });
}

describe("cycle time reports what it could not measure", () => {
  it("counts every finished item in coverage, not just the measurable ones", () => {
    // The failure this guards: a median over the three items that happen to
    // carry an actual_start, presented next to ten finished ones, reads as the
    // team's cycle time. It is the cycle time of whoever pressed Start.
    const result = cycleTime([
      tookDays(2),
      tookDays(4),
      tookDays(6),
      ...Array.from({ length: 7 }, () => item({ done: true, completedAt: new Date() })),
    ]);

    expect(result.coverage).toEqual({ measured: 3, done: 10 });
    expect(result.median).toBe(4);
  });

  it("excludes unfinished work even when it carries both timestamps", () => {
    // An item reopened after completion keeps its completed_at. `done` is the
    // authority on whether it is finished; the timestamp only on when.
    const reopened = tookDays(30, { done: false });
    const result = cycleTime([tookDays(2), reopened]);

    expect(result.coverage.measured).toBe(1);
    expect(result.median).toBe(2);
  });

  it("drops finished-before-started as an anomaly rather than clamping it to zero", () => {
    // Clamping turns one known-bad row into a plausible "0 days" that pulls the
    // median down and hides the fault permanently.
    const broken = item({
      done: true,
      actualStart: new Date("2026-03-10T12:00:00Z"),
      completedAt: new Date("2026-03-01T12:00:00Z"),
    });
    const result = cycleTime([tookDays(4), tookDays(6), broken]);

    expect(result.anomalies).toBe(1);
    expect(result.days).toEqual([4, 6]);
    expect(result.days).not.toContain(0);
  });

  it("keeps sub-day work fractional instead of rounding it to zero", () => {
    // A four-hour ticket reported as "0 days" reads as instantaneous.
    const result = cycleTime([tookDays(0.25)]);
    expect(result.median).toBeCloseTo(0.25, 5);
    expect(result.median).not.toBe(0);
  });

  it("returns nulls rather than zeros when nothing is measurable", () => {
    // Zero is a measurement. Null is the absence of one, and the renderer must
    // be able to tell them apart to say "not enough data" instead of "0 days".
    const result = cycleTime([item({ done: true })]);
    expect(result.median).toBeNull();
    expect(result.p85).toBeNull();
    expect(result.mean).toBeNull();
    // Finished, but with nothing to measure it by: it counts toward the work
    // this metric is failing to describe, which is exactly what coverage says.
    expect(result.coverage).toEqual({ measured: 0, done: 1 });
  });

  it("returns a p85 that some real item actually took", () => {
    const result = cycleTime([1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map((d) => tookDays(d)));
    expect(result.days).toContain(result.p85);
    expect(result.p85).toBe(9);
  });

  it("buckets the distribution without losing or duplicating an item", () => {
    const result = cycleTime([0.5, 1, 2, 3, 7, 15, 40].map((d) => tookDays(d)));
    const bucketed = result.histogram.reduce((s, b) => s + b.count, 0);
    expect(bucketed).toBe(result.days.length);
    expect(result.histogram.find((b) => b.label === "> 20 days")!.count).toBe(1);
  });
});

describe("throughput does not redraw the trend", () => {
  const intervals: ThroughputInterval[] = [
    { id: "s1", name: "Sprint 1", status: "COMPLETED", startDate: "2026-01-01", endDate: "2026-01-14" },
    { id: "s2", name: "Sprint 2", status: "COMPLETED", startDate: "2026-01-15", endDate: "2026-01-28" },
    { id: "s3", name: "Sprint 3", status: "ACTIVE", startDate: "2026-01-29", endDate: "2026-02-11" },
  ];

  it("keeps a sprint that delivered nothing", () => {
    // Dropping it closes the gap and silently redraws the trend as though the
    // sprint never happened — the most flattering possible edit.
    const series = throughput(
      [item({ intervalId: "s1", done: true }), item({ intervalId: "s3", done: true })],
      intervals,
    );

    expect(series.map((p) => p.name)).toEqual(["Sprint 1", "Sprint 2", "Sprint 3"]);
    expect(series[1].count).toBe(0);
  });

  it("orders oldest first regardless of the order intervals arrive in", () => {
    // The intervals API sorts by number DESC; a trend drawn in that order runs
    // backwards and every improving team looks like it is declining.
    const series = throughput([], [intervals[2], intervals[0], intervals[1]]);
    expect(series.map((p) => p.name)).toEqual(["Sprint 1", "Sprint 2", "Sprint 3"]);
  });

  it("flags the running sprint as partial", () => {
    const series = throughput([item({ intervalId: "s3", done: true })], intervals);
    expect(series.find((p) => p.name === "Sprint 3")!.isPartial).toBe(true);
    expect(series.find((p) => p.name === "Sprint 1")!.isPartial).toBe(false);
  });

  it("attributes carried-over work to the sprint it ended in", () => {
    const carried = item({ intervalId: "s2", done: true, completedAt: "2026-01-20" });
    const series = throughput([carried], intervals);
    expect(series.find((p) => p.name === "Sprint 2")!.count).toBe(1);
    expect(series.find((p) => p.name === "Sprint 1")!.count).toBe(0);
  });

  it("counts only finished items, while still reporting what was assigned", () => {
    const series = throughput(
      [
        item({ intervalId: "s1", done: true }),
        item({ intervalId: "s1", done: false }),
        item({ intervalId: "s1", done: false }),
      ],
      intervals,
    );
    const s1 = series.find((p) => p.name === "Sprint 1")!;
    expect(s1.count).toBe(1);
    expect(s1.total).toBe(3);
  });

  it("reports estimate coverage alongside the points figure", () => {
    const series = throughput(
      [
        item({ intervalId: "s1", done: true, storyPoints: 5 }),
        item({ intervalId: "s1", done: true, storyPoints: null }),
      ],
      intervals,
    );
    const s1 = series.find((p) => p.name === "Sprint 1")!;
    expect(s1.points).toBe(5);
    expect(s1.estimated).toBe(1);
    expect(s1.count).toBe(2);
  });

  it("excludes the running sprint from the average", () => {
    // Three days into a sprint the team has delivered three days of work.
    // Averaging that in drags the mean down every time anyone opens the page.
    const series = throughput(
      [
        ...Array.from({ length: 10 }, () => item({ intervalId: "s1", done: true })),
        ...Array.from({ length: 10 }, () => item({ intervalId: "s2", done: true })),
        item({ intervalId: "s3", done: true }),
      ],
      intervals,
    );
    const summary = throughputSummary(series);

    expect(summary.mean).toBe(10);
    expect(summary.closed).toBe(2);
  });

  it("reports variability so a flat mean cannot hide a wild spread", () => {
    const steady = throughputSummary([
      { intervalId: "a", name: "A", count: 10, points: 0, estimated: 0, total: 10, isPartial: false },
      { intervalId: "b", name: "B", count: 10, points: 0, estimated: 0, total: 10, isPartial: false },
    ]);
    const wild = throughputSummary([
      { intervalId: "a", name: "A", count: 2, points: 0, estimated: 0, total: 2, isPartial: false },
      { intervalId: "b", name: "B", count: 18, points: 0, estimated: 0, total: 18, isPartial: false },
    ]);

    expect(steady.mean).toBe(wild.mean);
    expect(steady.variability).toBe(0);
    expect(wild.variability!).toBeGreaterThan(0.5);
  });

  it("returns nulls, not zeros, when no sprint has closed", () => {
    const summary = throughputSummary([
      { intervalId: "s3", name: "Sprint 3", count: 4, points: 0, estimated: 0, total: 4, isPartial: true },
    ]);
    expect(summary.mean).toBeNull();
    expect(summary.closed).toBe(0);
  });
});

describe("work-type mix cuts capacity two ways", () => {
  const mixed = [
    item({ typeKey: "story", typeName: "Story", workCategory: "BUSINESS", done: true, storyPoints: 3 }),
    item({ typeKey: "story", typeName: "Story", workCategory: "BUSINESS" }),
    item({ typeKey: "bug", typeName: "Bug", typeColor: "#ef4444", workCategory: "BUSINESS" }),
    item({ typeKey: "spike", typeName: "Spike", workCategory: "ENABLER" }),
  ];

  it("ranks types by size", () => {
    const mix = workTypeMix(mixed);
    expect(mix.byType.map((t) => t.name)).toEqual(["Story", "Bug", "Spike"]);
    expect(mix.byType[0].count).toBe(2);
  });

  it("keeps a zero category so the split still reads as a ratio", () => {
    // With ENABLER omitted, "100% business" and "we have not classified
    // anything" render identically.
    const mix = workTypeMix([item({ workCategory: "BUSINESS" })]);
    expect(mix.byCategory.map((c) => c.category)).toEqual(["BUSINESS", "ENABLER"]);
    expect(mix.byCategory.find((c) => c.category === "ENABLER")!.count).toBe(0);
  });

  it("separates the enabler split from the type split", () => {
    // The whole point of carrying both: a Spike and a Story are both delivery in
    // the type cut, and only the category cut shows the enabler investment.
    const mix = workTypeMix(mixed);
    expect(mix.byCategory.find((c) => c.category === "ENABLER")!.count).toBe(1);
    expect(mix.byCategory.find((c) => c.category === "BUSINESS")!.count).toBe(3);
  });

  it("tracks finished work per slice, not just size", () => {
    const mix = workTypeMix(mixed);
    expect(mix.byType.find((t) => t.key === "story")!.done).toBe(1);
    expect(mix.byType.find((t) => t.key === "bug")!.done).toBe(0);
  });

  it("reports estimate coverage so the points columns can be qualified", () => {
    const mix = workTypeMix(mixed);
    expect(mix.total).toBe(4);
    expect(mix.estimated).toBe(1);
  });

  it("treats a zero or negative estimate as unestimated", () => {
    // 0 points is a filled-in field meaning "no estimate", not a 0-point item.
    const mix = workTypeMix([item({ storyPoints: 0 }), item({ storyPoints: -3 })]);
    expect(mix.estimated).toBe(0);
    expect(mix.byType[0].points).toBe(0);
  });

  it("preserves each type's own colour so charts match the boards", () => {
    const mix = workTypeMix(mixed);
    expect(mix.byType.find((t) => t.key === "bug")!.color).toBe("#ef4444");
  });
});
