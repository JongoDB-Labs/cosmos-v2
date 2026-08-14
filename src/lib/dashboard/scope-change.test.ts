// @vitest-environment node
//
// The load-bearing behaviour here is what this REFUSES to count. Any
// implementation can add up interval moves; the question is whether it counts
// backlog grooming as chaos, whether one indecisive ticket can dominate the
// chart, and what it claims when a sprint was empty at planning.
import { describe, it, expect } from "vitest";
import {
  scopeChange,
  carryover,
  predictability,
  type IntervalChange,
  type ScopeIntervalLike,
  type ScopeItemLike,
  type ScopeChangeRow,
} from "./scope-change";

const SPRINT: ScopeIntervalLike = {
  id: "s1",
  name: "Sprint 1",
  startDate: "2026-03-02T00:00:00Z",
  endDate: "2026-03-15T00:00:00Z",
  status: "COMPLETED",
};

const move = (workItemId: string, from: string | null, to: string | null, at: string): IntervalChange => ({
  workItemId,
  from,
  to,
  at,
});

const member = (id: string, done = false): ScopeItemLike => ({ id, intervalId: "s1", done });

describe("planning is not churn", () => {
  it("ignores everything that happened before the sprint started", () => {
    // Grooming a backlog into next sprint is the process working. Counting it
    // would make every well-planned sprint look chaotic and bury the handful of
    // mid-sprint injections that actually cost the team something.
    const rows = scopeChange(
      [
        move("a", null, "s1", "2026-02-25T10:00:00Z"),
        move("b", null, "s1", "2026-03-01T23:59:00Z"),
      ],
      [SPRINT],
      [member("a"), member("b")],
    );

    expect(rows[0].added).toBe(0);
    expect(rows[0].committed).toBe(2);
  });

  it("counts a move made ON the start instant as in-sprint", () => {
    // The boundary belongs to the sprint: work injected the morning it opens is
    // not planning, and an exclusive comparison would silently drop it.
    const rows = scopeChange(
      [move("a", null, "s1", "2026-03-02T00:00:00Z")],
      [SPRINT],
      [member("a")],
    );
    expect(rows[0].added).toBe(1);
  });
});

describe("one indecisive ticket cannot dominate the chart", () => {
  it("counts an item once however many times it moves", () => {
    const rows = scopeChange(
      [
        move("a", null, "s1", "2026-03-05T10:00:00Z"),
        move("a", "s1", null, "2026-03-06T10:00:00Z"),
        move("a", null, "s1", "2026-03-07T10:00:00Z"),
      ],
      [SPRINT],
      [member("a")],
    );

    // In, out, in — net one addition, not three additions and a removal.
    expect(rows[0].added).toBe(1);
    expect(rows[0].removed).toBe(0);
  });

  it("cancels an item that left and came back rather than counting both ways", () => {
    const rows = scopeChange(
      [
        move("a", "s1", null, "2026-03-05T10:00:00Z"),
        move("a", null, "s1", "2026-03-09T10:00:00Z"),
      ],
      [SPRINT],
      [member("a")],
    );
    expect(rows[0].added).toBe(0);
    expect(rows[0].removed).toBe(0);
  });
});

describe("committed is reconstructed, and says so by its arithmetic", () => {
  it("subtracts late arrivals and adds back what was pushed out", () => {
    // Now: a, b, c. `c` arrived mid-sprint; `d` was pushed out mid-sprint.
    // So planning had a, b, d = 3.
    const rows = scopeChange(
      [
        move("c", null, "s1", "2026-03-06T10:00:00Z"),
        move("d", "s1", null, "2026-03-07T10:00:00Z"),
      ],
      [SPRINT],
      [member("a"), member("b"), member("c")],
    );

    expect(rows[0].current).toBe(3);
    expect(rows[0].added).toBe(1);
    expect(rows[0].removed).toBe(1);
    expect(rows[0].committed).toBe(3);
  });

  it("never reports a negative commitment", () => {
    // More additions than current members means the log and the membership
    // disagree; the floor keeps a broken input from rendering as "-2 committed".
    const rows = scopeChange(
      [
        move("x", null, "s1", "2026-03-06T10:00:00Z"),
        move("y", null, "s1", "2026-03-06T10:00:00Z"),
      ],
      [SPRINT],
      [member("x")],
    );
    expect(rows[0].committed).toBe(0);
    expect(rows[0].committed).toBeGreaterThanOrEqual(0);
  });
});

describe("commitment kept refuses to divide by an empty plan", () => {
  it("returns null rather than a percentage when nothing was committed", () => {
    // Finishing 3 items from a sprint that was empty at planning is not 300%
    // delivery. The `added` count is what tells that story.
    const rows = scopeChange(
      [
        move("a", null, "s1", "2026-03-06T10:00:00Z"),
        move("b", null, "s1", "2026-03-06T10:00:00Z"),
      ],
      [SPRINT],
      [member("a", true), member("b", true)],
    );

    expect(rows[0].committed).toBe(0);
    expect(rows[0].commitmentKept).toBeNull();
    expect(rows[0].churnRate).toBeNull();
    expect(rows[0].completed).toBe(2);
  });

  it("computes commitment kept against the plan, not against what is there now", () => {
    // Current = 4 (one arrived late), completed = 3, committed = 3.
    // Against current that is 75%; against the plan it is 100%, and the plan is
    // what was promised.
    const rows = scopeChange(
      [move("late", null, "s1", "2026-03-08T10:00:00Z")],
      [SPRINT],
      [member("a", true), member("b", true), member("c", true), member("late")],
    );

    expect(rows[0].committed).toBe(3);
    expect(rows[0].completed).toBe(3);
    expect(rows[0].commitmentKept).toBe(100);
  });
});

describe("the series stays readable", () => {
  it("orders intervals oldest first regardless of input order", () => {
    const later: ScopeIntervalLike = { ...SPRINT, id: "s2", name: "Sprint 2", startDate: "2026-03-16T00:00:00Z" };
    const rows = scopeChange([], [later, SPRINT], []);
    expect(rows.map((r) => r.name)).toEqual(["Sprint 1", "Sprint 2"]);
  });

  it("keeps an interval with no movement at all", () => {
    const rows = scopeChange([], [SPRINT], [member("a")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].added).toBe(0);
    expect(rows[0].churnRate).toBe(0);
  });

  it("does not attribute one sprint's churn to another", () => {
    const other: ScopeIntervalLike = { ...SPRINT, id: "s2", name: "Sprint 2" };
    const rows = scopeChange(
      [move("a", "s2", "s1", "2026-03-06T10:00:00Z")],
      [SPRINT, other],
      [member("a")],
    );
    expect(rows.find((r) => r.intervalId === "s1")!.added).toBe(1);
    expect(rows.find((r) => r.intervalId === "s2")!.removed).toBe(1);
  });
});

describe("carryover is sprint-to-sprint, not descoping", () => {
  const s1: ScopeIntervalLike = { ...SPRINT, id: "s1", name: "Sprint 1", startDate: "2026-03-02T00:00:00Z" };
  const s2: ScopeIntervalLike = { ...SPRINT, id: "s2", name: "Sprint 2", startDate: "2026-03-16T00:00:00Z" };
  const s3: ScopeIntervalLike = { ...SPRINT, id: "s3", name: "Sprint 3", startDate: "2026-03-30T00:00:00Z" };

  it("does not count a move back to the backlog as carryover", () => {
    // Dropping work is descoping — scopeChange already reports it as `removed`.
    // Counting it here would flatter a team that keeps dropping work and punish
    // one that keeps honouring it.
    const { rows } = carryover([move("a", "s1", null, "2026-03-10T00:00:00Z")], [s1, s2]);
    expect(rows.find((r) => r.intervalId === "s1")!.carriedOut).toBe(0);
  });

  it("counts a slip forward on both sides of the move", () => {
    const { rows } = carryover([move("a", "s1", "s2", "2026-03-14T00:00:00Z")], [s1, s2]);
    expect(rows.find((r) => r.intervalId === "s1")!.carriedOut).toBe(1);
    expect(rows.find((r) => r.intervalId === "s2")!.carriedIn).toBe(1);
  });

  it("ignores a move into an EARLIER sprint", () => {
    // Pulling work forward into a sprint that already started is a correction,
    // not a slip, and scoring it as carryover would invent a failure.
    const { rows } = carryover([move("a", "s2", "s1", "2026-03-20T00:00:00Z")], [s1, s2]);
    expect(rows.find((r) => r.intervalId === "s2")!.carriedOut).toBe(0);
    expect(rows.find((r) => r.intervalId === "s1")!.carriedIn).toBe(0);
  });

  it("surfaces the tickets that slipped more than once", () => {
    // One slip is a sprint that ran long. The same ticket slipping repeatedly is
    // something nobody is actually working on, and that is the conversation.
    const { repeatOffenders } = carryover(
      [
        move("a", "s1", "s2", "2026-03-14T00:00:00Z"),
        move("a", "s2", "s3", "2026-03-28T00:00:00Z"),
        move("b", "s1", "s2", "2026-03-14T00:00:00Z"),
      ],
      [s1, s2, s3],
    );
    expect(repeatOffenders).toEqual([{ workItemId: "a", hops: 2 }]);
  });

  it("skips a move involving an interval it does not know", () => {
    const { rows } = carryover([move("a", "s1", "unknown", "2026-03-14T00:00:00Z")], [s1, s2]);
    expect(rows.every((r) => r.carriedIn === 0 && r.carriedOut === 0)).toBe(true);
  });
});

describe("predictability refuses to speak too early", () => {
  const closed = (ids: string[]) => new Set(ids);
  const row = (id: string, kept: number | null): ScopeChangeRow => ({
    intervalId: id,
    name: id,
    added: 0,
    removed: 0,
    committed: kept === null ? 0 : 10,
    current: 10,
    completed: kept === null ? 0 : kept / 10,
    commitmentKept: kept,
    churnRate: 0,
  });

  it("reports a shortfall rather than a number below the floor", () => {
    const p = predictability(
      [row("a", 90), row("b", 80), row("c", 100)],
      closed(["a", "b", "c"]),
    );
    expect(p.mean).toBeNull();
    expect(p.stdDev).toBeNull();
    expect(p.shortfall).toEqual({ needs: 5, has: 3 });
  });

  it("reports once there are enough closed intervals", () => {
    const p = predictability(
      [row("a", 90), row("b", 90), row("c", 90), row("d", 90), row("e", 90)],
      closed(["a", "b", "c", "d", "e"]),
    );
    expect(p.mean).toBe(90);
    expect(p.stdDev).toBe(0);
    expect(p.shortfall).toBeNull();
  });

  it("excludes intervals that committed to nothing rather than scoring them zero", () => {
    // A sprint empty at planning and filled later says nothing about whether
    // this team keeps its word; a 0% would drag the mean down as though it did.
    const p = predictability(
      [row("a", 90), row("b", 90), row("c", 90), row("d", 90), row("e", 90), row("f", null)],
      closed(["a", "b", "c", "d", "e", "f"]),
    );
    expect(p.samples).toBe(5);
    expect(p.mean).toBe(90);
  });

  it("ignores intervals that have not closed", () => {
    // A sprint still running has not had its chance to deliver.
    const p = predictability(
      [row("a", 90), row("b", 90), row("c", 90), row("d", 90), row("e", 90), row("live", 10)],
      closed(["a", "b", "c", "d", "e"]),
    );
    expect(p.samples).toBe(5);
    expect(p.mean).toBe(90);
  });
});
