import { describe, it, expect } from "vitest";
import { planDriftPhantoms, type DriftPhantom } from "./plan-drift";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Compact shape for assertions: colour + the span it covers. */
function shape(p: DriftPhantom) {
  return [p.color, p.from.toISOString().slice(0, 10), p.to.toISOString().slice(0, 10)];
}

describe("planDriftPhantoms", () => {
  it("draws nothing without an actual start — the plan IS the bar then", () => {
    expect(
      planDriftPhantoms({
        plannedStart: d("2026-03-01"),
        plannedEnd: d("2026-03-10"),
        actualStart: null,
        actualEnd: null,
      }),
    ).toEqual([]);
  });

  it("a late start is AMBER and covers planned start -> actual start", () => {
    // Sits to the LEFT of the block: the block begins at the actual start.
    const out = planDriftPhantoms({
      plannedStart: d("2026-03-01"),
      plannedEnd: d("2026-03-20"),
      actualStart: d("2026-03-05"),
      actualEnd: d("2026-03-18"),
    });
    expect(out.map(shape)).toEqual([["amber", "2026-03-01", "2026-03-05"]]);
  });

  it("an early start is GREEN and covers actual start -> planned start", () => {
    // Same phantom, flipped: it sits to the RIGHT of the block's left edge.
    const out = planDriftPhantoms({
      plannedStart: d("2026-03-05"),
      plannedEnd: d("2026-03-20"),
      actualStart: d("2026-03-01"),
      actualEnd: d("2026-03-18"),
    });
    expect(out.map(shape)).toEqual([["green", "2026-03-01", "2026-03-05"]]);
  });

  it("starting exactly on plan draws no start phantom, not a zero-width one", () => {
    const out = planDriftPhantoms({
      plannedStart: d("2026-03-01"),
      plannedEnd: d("2026-03-20"),
      actualStart: d("2026-03-01"),
      actualEnd: d("2026-03-10"),
    });
    expect(out).toEqual([]);
  });

  it("a slipped end is RED and covers planned end -> actual end only", () => {
    // The whole point: red marks the SLIP, not the entire planned span.
    const out = planDriftPhantoms({
      plannedStart: d("2026-03-01"),
      plannedEnd: d("2026-03-10"),
      actualStart: d("2026-03-01"),
      actualEnd: d("2026-03-14"),
    });
    expect(out.map(shape)).toEqual([["red", "2026-03-10", "2026-03-14"]]);
  });

  it("finishing early draws NO end phantom", () => {
    const out = planDriftPhantoms({
      plannedStart: d("2026-03-01"),
      plannedEnd: d("2026-03-20"),
      actualStart: d("2026-03-01"),
      actualEnd: d("2026-03-12"),
    });
    expect(out).toEqual([]);
  });

  it("finishing exactly on plan draws no end phantom", () => {
    const out = planDriftPhantoms({
      plannedStart: d("2026-03-01"),
      plannedEnd: d("2026-03-10"),
      actualStart: d("2026-03-01"),
      actualEnd: d("2026-03-10"),
    });
    expect(out).toEqual([]);
  });

  it("started late AND slipped shows both, with RED LAST so it paints on top", () => {
    const out = planDriftPhantoms({
      plannedStart: d("2026-03-01"),
      plannedEnd: d("2026-03-10"),
      actualStart: d("2026-03-04"),
      actualEnd: d("2026-03-15"),
    });
    expect(out.map(shape)).toEqual([
      ["amber", "2026-03-01", "2026-03-04"],
      ["red", "2026-03-10", "2026-03-15"],
    ]);
    expect(out[out.length - 1].color).toBe("red");
  });

  it("started early AND slipped shows green then red, red last", () => {
    const out = planDriftPhantoms({
      plannedStart: d("2026-03-05"),
      plannedEnd: d("2026-03-10"),
      actualStart: d("2026-03-01"),
      actualEnd: d("2026-03-16"),
    });
    expect(out.map(shape)).toEqual([
      ["green", "2026-03-01", "2026-03-05"],
      ["red", "2026-03-10", "2026-03-16"],
    ]);
    expect(out[out.length - 1].color).toBe("red");
  });

  it("never emits a phantom whose end precedes its start", () => {
    const cases: Parameters<typeof planDriftPhantoms>[0][] = [
      { plannedStart: d("2026-03-01"), plannedEnd: d("2026-03-10"), actualStart: d("2026-03-09"), actualEnd: d("2026-03-20") },
      { plannedStart: d("2026-03-09"), plannedEnd: d("2026-03-10"), actualStart: d("2026-03-01"), actualEnd: d("2026-03-02") },
    ];
    for (const c of cases) {
      for (const p of planDriftPhantoms(c)) {
        expect(p.to.getTime()).toBeGreaterThan(p.from.getTime());
      }
    }
  });

  it("a running item slips against today, not only on completion", () => {
    // actualEnd is `completedAt ?? today` at the call site, so an overdue item
    // in flight still shows its slip growing.
    const out = planDriftPhantoms({
      plannedStart: d("2026-03-01"),
      plannedEnd: d("2026-03-10"),
      actualStart: d("2026-03-01"),
      actualEnd: d("2026-03-13"), // "today"
    });
    expect(out.map(shape)).toEqual([["red", "2026-03-10", "2026-03-13"]]);
  });

  it("tolerates a missing planned start or end without inventing a phantom", () => {
    expect(
      planDriftPhantoms({
        plannedStart: null,
        plannedEnd: d("2026-03-10"),
        actualStart: d("2026-03-04"),
        actualEnd: d("2026-03-08"),
      }),
    ).toEqual([]);
    expect(
      planDriftPhantoms({
        plannedStart: d("2026-03-01"),
        plannedEnd: null,
        actualStart: d("2026-03-01"),
        actualEnd: d("2026-03-20"),
      }),
    ).toEqual([]);
  });
});
