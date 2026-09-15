import { describe, it, expect } from "vitest";
import { sprintTrend, piRollup } from "./sprint-trend";

/**
 * Sprint Health only ever showed the ACTIVE sprint, so the two questions a team
 * actually asks between ceremonies — "are we getting faster or slower?" and "how
 * is the increment as a whole doing?" — had no answer in the product.
 *
 * Both are already recorded: completing a sprint writes velocity and counts to
 * `intervals.report`. These read that, defensively, because `report` is a JSON
 * column and nothing below the application guarantees its shape.
 */

const done = (
  number: number,
  name: string,
  report: Record<string, unknown> | null,
  parentId: string | null = null,
) => ({ id: `s${number}`, number, name, status: "COMPLETED" as const, parentId, report });

describe("sprintTrend", () => {
  it("returns one point per COMPLETED sprint, oldest first", () => {
    // A trend read right-to-left is a trend read backwards.
    const t = sprintTrend([
      done(3, "Sprint 3", { velocity: 30, completedItems: 6, totalItems: 8 }),
      done(1, "Sprint 1", { velocity: 10, completedItems: 2, totalItems: 5 }),
      done(2, "Sprint 2", { velocity: 20, completedItems: 4, totalItems: 6 }),
    ]);
    expect(t.map((p) => p.name)).toEqual(["Sprint 1", "Sprint 2", "Sprint 3"]);
    expect(t.map((p) => p.velocity)).toEqual([10, 20, 30]);
  });

  it("excludes sprints that have not finished", () => {
    // An in-flight sprint's velocity is not comparable to a finished one's; a
    // half-done sprint plotted next to complete ones reads as a collapse.
    const t = sprintTrend([
      done(1, "Sprint 1", { velocity: 10 }),
      // A VALID report on purpose: with `report: null` the parse would reject it
      // anyway and this test would pass without the status check ever running.
      {
        id: "s2",
        number: 2,
        name: "Sprint 2",
        status: "ACTIVE" as const,
        parentId: null,
        report: { velocity: 99, completedItems: 1, totalItems: 9 },
      },
    ]);
    expect(t.map((p) => p.name)).toEqual(["Sprint 1"]);
  });

  it("skips a completed sprint with no usable report rather than plotting zero", () => {
    // Zero velocity and "we never recorded it" are different facts, and a zero
    // on the chart is a story about the team that the data does not support.
    const t = sprintTrend([
      done(1, "Sprint 1", { velocity: 10 }),
      done(2, "Sprint 2", null),
      done(3, "Sprint 3", { notAReport: true }),
    ]);
    expect(t.map((p) => p.name)).toEqual(["Sprint 1"]);
  });

  it("computes completion as a percentage of items", () => {
    const [p] = sprintTrend([done(1, "S1", { velocity: 8, completedItems: 3, totalItems: 4 })]);
    expect(p.completionPct).toBe(75);
  });

  it("reports 0% completion for an empty sprint rather than dividing by zero", () => {
    const [p] = sprintTrend([done(1, "S1", { velocity: 0, completedItems: 0, totalItems: 0 })]);
    expect(p.completionPct).toBe(0);
  });
});

describe("piRollup", () => {
  const pi = { id: "pi1", number: 100, name: "PI-001" };

  it("sums the increment's finished sprints", () => {
    const r = piRollup(pi, [
      done(1, "S1", { velocity: 10, completedItems: 2, totalItems: 4 }, "pi1"),
      done(2, "S2", { velocity: 20, completedItems: 3, totalItems: 5 }, "pi1"),
    ]);
    expect(r.velocity).toBe(30);
    expect(r.completedItems).toBe(5);
    expect(r.totalItems).toBe(9);
    expect(r.sprintsCompleted).toBe(2);
  });

  it("ignores sprints belonging to a DIFFERENT increment", () => {
    const r = piRollup(pi, [
      done(1, "S1", { velocity: 10 }, "pi1"),
      done(2, "S2", { velocity: 99 }, "pi2"),
    ]);
    expect(r.velocity).toBe(10);
    expect(r.sprintsCompleted).toBe(1);
  });

  it("reports an average velocity per finished sprint", () => {
    const r = piRollup(pi, [
      done(1, "S1", { velocity: 10 }, "pi1"),
      done(2, "S2", { velocity: 20 }, "pi1"),
    ]);
    expect(r.averageVelocity).toBe(15);
  });

  it("does not divide by zero for an increment with nothing finished", () => {
    const r = piRollup(pi, []);
    expect(r.averageVelocity).toBe(0);
    expect(r.sprintsCompleted).toBe(0);
  });
});
