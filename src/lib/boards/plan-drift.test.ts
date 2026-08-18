import { describe, it, expect } from "vitest";
import { planDriftPhantoms, type DriftMark } from "./plan-drift";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Compact shape for assertions: colour + style + edge + the span it covers. */
function shape(m: DriftMark) {
  return [m.color, m.style, m.edge, m.from.toISOString().slice(0, 10), m.to.toISOString().slice(0, 10)];
}

const PLAN = { plannedStart: d("2026-03-10"), plannedEnd: d("2026-03-20") };

describe("planDriftPhantoms — colour is ahead-vs-behind", () => {
  it("a start AHEAD of plan is GREEN", () => {
    const out = planDriftPhantoms({ ...PLAN, actualStart: d("2026-03-05"), actualEnd: d("2026-03-20") });
    expect(out.map((m) => m.color)).toEqual(["green"]);
  });

  it("a start BEHIND plan is RED", () => {
    const out = planDriftPhantoms({ ...PLAN, actualStart: d("2026-03-15"), actualEnd: d("2026-03-20") });
    expect(out.map((m) => m.color)).toEqual(["red"]);
  });

  it("an end AHEAD of plan is GREEN", () => {
    const out = planDriftPhantoms({ ...PLAN, actualStart: d("2026-03-10"), actualEnd: d("2026-03-15") });
    expect(out.map((m) => m.color)).toEqual(["green"]);
  });

  it("an end BEHIND plan is RED", () => {
    const out = planDriftPhantoms({ ...PLAN, actualStart: d("2026-03-10"), actualEnd: d("2026-03-25") });
    expect(out.map((m) => m.color)).toEqual(["red"]);
  });
});

describe("planDriftPhantoms — style is overlay-vs-bare-canvas", () => {
  // The bar spans the ACTUALS, so which side of it a mark lands on is decided
  // entirely by the sign. Striped means it covers real work.
  it("an early start STRIPES, because it lies over the bar's head", () => {
    const out = planDriftPhantoms({ ...PLAN, actualStart: d("2026-03-05"), actualEnd: d("2026-03-20") });
    expect(out.map(shape)).toEqual([["green", "striped", "start", "2026-03-05", "2026-03-10"]]);
  });

  it("a late start is a PHANTOM, because the bar has not begun yet", () => {
    const out = planDriftPhantoms({ ...PLAN, actualStart: d("2026-03-15"), actualEnd: d("2026-03-20") });
    expect(out.map(shape)).toEqual([["red", "phantom", "start", "2026-03-10", "2026-03-15"]]);
  });

  it("an early finish is a PHANTOM, because the bar already stopped", () => {
    const out = planDriftPhantoms({ ...PLAN, actualStart: d("2026-03-10"), actualEnd: d("2026-03-15") });
    expect(out.map(shape)).toEqual([["green", "phantom", "end", "2026-03-15", "2026-03-20"]]);
  });

  it("a late finish STRIPES, because it lies over the bar's tail", () => {
    const out = planDriftPhantoms({ ...PLAN, actualStart: d("2026-03-10"), actualEnd: d("2026-03-25") });
    expect(out.map(shape)).toEqual([["red", "striped", "end", "2026-03-20", "2026-03-25"]]);
  });
});

describe("planDriftPhantoms — nothing to say", () => {
  it("draws nothing at all without any actuals", () => {
    expect(planDriftPhantoms({ ...PLAN, actualStart: null, actualEnd: null })).toEqual([]);
  });

  it("starting exactly on plan draws no start mark, not a zero-width sliver", () => {
    const out = planDriftPhantoms({ ...PLAN, actualStart: d("2026-03-10"), actualEnd: d("2026-03-20") });
    expect(out).toEqual([]);
  });

  it("finishing exactly on plan draws no end mark", () => {
    const out = planDriftPhantoms({ ...PLAN, actualStart: d("2026-03-05"), actualEnd: d("2026-03-20") });
    expect(out.filter((m) => m.edge === "end")).toEqual([]);
  });

  it("invents nothing when the plan has no start", () => {
    const out = planDriftPhantoms({
      plannedStart: null, plannedEnd: d("2026-03-20"),
      actualStart: d("2026-03-05"), actualEnd: d("2026-03-25"),
    });
    expect(out.map((m) => m.edge)).toEqual(["end"]);
  });

  it("invents nothing when the plan has no end", () => {
    const out = planDriftPhantoms({
      plannedStart: d("2026-03-10"), plannedEnd: null,
      actualStart: d("2026-03-05"), actualEnd: d("2026-03-25"),
    });
    expect(out.map((m) => m.edge)).toEqual(["start"]);
  });

  it("never emits a mark whose end precedes its start", () => {
    const cases: Array<[string, string]> = [
      ["2026-03-05", "2026-03-25"], ["2026-03-15", "2026-03-15"], ["2026-03-10", "2026-03-12"],
    ];
    for (const [as, ae] of cases) {
      for (const m of planDriftPhantoms({ ...PLAN, actualStart: d(as), actualEnd: d(ae) })) {
        expect(m.to.getTime()).toBeGreaterThan(m.from.getTime());
      }
    }
  });
});

describe("planDriftPhantoms — both ends at once, and paint order", () => {
  it("early start AND late finish: green stripe then red stripe, red last", () => {
    const out = planDriftPhantoms({ ...PLAN, actualStart: d("2026-03-05"), actualEnd: d("2026-03-25") });
    expect(out.map(shape)).toEqual([
      ["green", "striped", "start", "2026-03-05", "2026-03-10"],
      ["red", "striped", "end", "2026-03-20", "2026-03-25"],
    ]);
  });

  it("late start AND early finish: both phantoms, red last", () => {
    const out = planDriftPhantoms({ ...PLAN, actualStart: d("2026-03-12"), actualEnd: d("2026-03-18") });
    expect(out.map(shape)).toEqual([
      ["green", "phantom", "end", "2026-03-18", "2026-03-20"],
      ["red", "phantom", "start", "2026-03-10", "2026-03-12"],
    ]);
  });

  it("PHANTOMS always precede STRIPES — they belong behind the bar", () => {
    // Late start (phantom) + late finish (stripe).
    const out = planDriftPhantoms({ ...PLAN, actualStart: d("2026-03-15"), actualEnd: d("2026-03-25") });
    expect(out.map((m) => m.style)).toEqual(["phantom", "striped"]);
  });
});

describe("planDriftPhantoms — a finish with no recorded start", () => {
  // Imported work, and tickets whose actual_start was cleared in bulk. The slip
  // is real; gating the whole function on actualStart used to hide it.
  it("still draws the end mark — as a shadow, since the bar sits on the plan", () => {
    const out = planDriftPhantoms({ ...PLAN, actualStart: null, actualEnd: d("2026-03-25") });
    expect(out.map(shape)).toEqual([["red", "phantom", "end", "2026-03-20", "2026-03-25"]]);
  });

  it("draws no START mark, because there is no date to draw to", () => {
    const out = planDriftPhantoms({ ...PLAN, actualStart: null, actualEnd: d("2026-03-25") });
    expect(out.every((m) => m.edge === "end")).toBe(true);
  });

  it("a known finish that beat the plan is GREEN, striped over the planned bar", () => {
    const out = planDriftPhantoms({ ...PLAN, actualStart: null, actualEnd: d("2026-03-16") });
    expect(out.map(shape)).toEqual([["green", "striped", "end", "2026-03-16", "2026-03-20"]]);
  });
});

// A ticket with a known finish and no recorded start draws its bar on the
// PLANNED dates, so "which side of the bar" inverts: the slip lands beyond it
// and the early finish lands inside it.
describe("planDriftPhantoms — style follows the BAR, not the edge", () => {
  it("a slip with no recorded start is a SHADOW, not stripes on bare canvas", () => {
    const out = planDriftPhantoms({ ...PLAN, actualStart: null, actualEnd: d("2026-03-25") });
    expect(out.map(shape)).toEqual([["red", "phantom", "end", "2026-03-20", "2026-03-25"]]);
  });

  it("an early finish with no recorded start STRIPES — it lies over the planned bar", () => {
    const out = planDriftPhantoms({ ...PLAN, actualStart: null, actualEnd: d("2026-03-16") });
    expect(out.map(shape)).toEqual([["green", "striped", "end", "2026-03-16", "2026-03-20"]]);
  });

  it("with actuals present the same two cases swap style", () => {
    const late = planDriftPhantoms({ ...PLAN, actualStart: d("2026-03-10"), actualEnd: d("2026-03-25") });
    const early = planDriftPhantoms({ ...PLAN, actualStart: d("2026-03-10"), actualEnd: d("2026-03-16") });
    expect(late.map((m) => m.style)).toEqual(["striped"]);
    expect(early.map((m) => m.style)).toEqual(["phantom"]);
  });
});
