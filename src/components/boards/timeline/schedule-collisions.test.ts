// Which drops count as a collision with a sibling (see schedule-collisions.ts).
import { describe, it, expect } from "vitest";
import { findCollisions, overlaps } from "./schedule-collisions";

// Local midnight, the day the chart draws.
const d = (ymd: string) => {
  const [y, m, day] = ymd.split("-").map(Number);
  return new Date(y, m - 1, day);
};
const iso = (ymd: string) => d(ymd).toISOString();
const range = (s: string, e: string) => ({ start: d(s), end: d(e) });
const item = (id: string, parentId: string | null, s: string | null, e: string | null) => ({
  id,
  parentId,
  startDate: s && iso(s),
  dueDate: e && iso(e),
});

// Phase A (moved) and its sibling phase B, which runs after it.
const B = item("b", "p", "2026-03-10", "2026-03-20");
const moveA = (after: [string, string], before: [string, string] = ["2026-03-01", "2026-03-05"]) => ({
  id: "a",
  parentId: "p",
  before: range(...before),
  after: range(...after),
});

describe("overlaps", () => {
  it("sharing only a boundary day is a handover, not an overlap", () => {
    expect(overlaps(range("2026-03-01", "2026-03-10"), range("2026-03-10", "2026-03-20"))).toBe(false);
    expect(overlaps(range("2026-03-01", "2026-03-11"), range("2026-03-10", "2026-03-20"))).toBe(true);
  });
});

describe("findCollisions", () => {
  it("a drop onto a sibling's dates is a collision", () => {
    const [c] = findCollisions(moveA(["2026-03-08", "2026-03-12"]), [B]);
    expect(c.id).toBe("b");
  });

  it("offers to push the sibling to start when the moved one ends, keeping its length", () => {
    const [c] = findCollisions(moveA(["2026-03-08", "2026-03-12"]), [B]);
    expect(c.later).toEqual(range("2026-03-12", "2026-03-22"));
  });

  it("or to end when the moved one starts, keeping its length", () => {
    const [c] = findCollisions(moveA(["2026-03-15", "2026-03-18"]), [B]);
    expect(c.earlier).toEqual(range("2026-03-05", "2026-03-15"));
  });

  it("no overlap, or only a shared boundary day, is not a collision", () => {
    expect(findCollisions(moveA(["2026-03-02", "2026-03-06"]), [B])).toEqual([]);
    expect(findCollisions(moveA(["2026-03-06", "2026-03-10"]), [B])).toEqual([]);
  });

  it("siblings that already overlapped before the drop were decided on earlier", () => {
    expect(findCollisions(moveA(["2026-03-12", "2026-03-14"], ["2026-03-11", "2026-03-13"]), [B])).toEqual([]);
  });

  it("only siblings: another parent's item, or a top-level item, never collides", () => {
    expect(findCollisions(moveA(["2026-03-08", "2026-03-12"]), [item("c", "q", "2026-03-10", "2026-03-20")])).toEqual([]);
    const topLevel = { ...moveA(["2026-03-08", "2026-03-12"]), parentId: null };
    expect(findCollisions(topLevel, [item("c", null, "2026-03-10", "2026-03-20")])).toEqual([]);
  });

  it("a sibling without both dates is drawn from fallbacks, not a plan, so it doesn't collide", () => {
    // Moved in from April, so only the missing date could make it look "new".
    const fromApril = moveA(["2026-03-08", "2026-03-12"], ["2026-04-01", "2026-04-05"]);
    expect(findCollisions(fromApril, [item("c", "p", null, "2026-03-20")])).toEqual([]);
    expect(findCollisions(fromApril, [item("c", "p", "2026-03-10", null)])).toEqual([]);
    // The same sibling with both dates does collide, so the case above is real.
    expect(findCollisions(fromApril, [item("c", "p", "2026-03-10", "2026-03-20")])).toHaveLength(1);
  });

  it("never collides with itself, and lists every sibling it newly lands on", () => {
    const C = item("c", "p", "2026-03-11", "2026-03-15");
    const self = item("a", "p", "2026-03-01", "2026-03-05");
    expect(findCollisions(moveA(["2026-03-08", "2026-03-12"]), [self, B, C]).map((c) => c.id)).toEqual(["b", "c"]);
  });
});
