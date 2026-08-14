// @vitest-environment node
//
// The two things worth pinning: that BOTH link directions are read (reading one
// silently misses half the impediments and still looks like a working feature),
// and that stretch objectives stay out of the commitment average.
import { describe, it, expect } from "vitest";
import {
  impediments,
  objectiveRollup,
  type WorkItemLinkLike,
  type ObjectiveLike,
} from "./impediments";

const NOW = new Date("2026-03-20T12:00:00Z");

const link = (over: Partial<WorkItemLinkLike> = {}): WorkItemLinkLike => ({
  id: Math.random().toString(36).slice(2),
  type: "BLOCKED_BY",
  sourceItemId: "a",
  targetItemId: "b",
  sourceTicketNumber: 1,
  sourceTitle: "Payment retries",
  targetTicketNumber: 2,
  targetTitle: "Vendor API",
  createdAt: "2026-03-18T12:00:00Z",
  ...over,
});

describe("impediments read both link directions", () => {
  it("treats A BLOCKED_BY B as A being stuck", () => {
    const { blocked } = impediments([link({ type: "BLOCKED_BY" })], new Set(), NOW);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].workItemId).toBe("a");
    expect(blocked[0].blockedByTicketNumber).toBe(2);
  });

  it("treats A BLOCKS B as B being stuck", () => {
    // Same fact, stored from the other end. Which one exists depends on which
    // side the user was looking at; reading only one direction would miss half
    // the impediments on the board and still look like a working panel.
    const { blocked } = impediments([link({ type: "BLOCKS" })], new Set(), NOW);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].workItemId).toBe("b");
    expect(blocked[0].blockedByTicketNumber).toBe(1);
  });

  it("ignores link types that are not about blocking", () => {
    const { blocked } = impediments(
      [link({ type: "RELATES" }), link({ type: "DUPLICATES" })],
      new Set(),
      NOW,
    );
    expect(blocked).toHaveLength(0);
  });
});

describe("finished work is not an impediment", () => {
  it("excludes a blocked item that is already done, and counts the stale link", () => {
    // Work that shipped is not stuck. Counting it would inflate the number
    // whose whole job is to prompt action.
    const result = impediments([link({ sourceItemId: "a" })], new Set(["a"]), NOW);
    expect(result.blocked).toHaveLength(0);
    expect(result.staleLinks).toBe(1);
  });

  it("still reports the live ones alongside the stale count", () => {
    const result = impediments(
      [link({ sourceItemId: "a" }), link({ sourceItemId: "c", sourceTicketNumber: 3 })],
      new Set(["a"]),
      NOW,
    );
    expect(result.blocked.map((b) => b.workItemId)).toEqual(["c"]);
    expect(result.staleLinks).toBe(1);
  });
});

describe("the oldest block sorts first", () => {
  it("orders by how long the block has stood", () => {
    const { blocked } = impediments(
      [
        link({ sourceItemId: "new", createdAt: "2026-03-19T12:00:00Z" }),
        link({ sourceItemId: "old", createdAt: "2026-03-01T12:00:00Z" }),
      ],
      new Set(),
      NOW,
    );
    expect(blocked.map((b) => b.workItemId)).toEqual(["old", "new"]);
    expect(blocked[0].daysBlocked).toBeCloseTo(19, 0);
  });

  it("never reports a negative age from a clock skew", () => {
    const { blocked } = impediments(
      [link({ createdAt: "2026-04-01T12:00:00Z" })],
      new Set(),
      NOW,
    );
    expect(blocked[0].daysBlocked).toBe(0);
  });
});

describe("stretch objectives stay out of the commitment", () => {
  const obj = (over: Partial<ObjectiveLike>): ObjectiveLike => ({
    id: Math.random().toString(36).slice(2),
    title: "Objective",
    status: "ACTIVE",
    progress: 0,
    intervalId: "pi1",
    ...over,
  });

  it("averages committed objectives only", () => {
    // SAFe stretch objectives are deliberately outside the commitment: they let
    // a team surface upside without being judged on it. Averaging a 0% stretch
    // in is the single most common way a PI reads worse than it went.
    const r = objectiveRollup(
      [obj({ progress: 100 }), obj({ progress: 80 }), obj({ progress: 0, committed: false })],
      "pi1",
    );
    expect(r.committedProgress).toBe(90);
    expect(r.stretch).toHaveLength(1);
  });

  it("treats an objective with no committed flag as committed", () => {
    // Matches the API's own default — one recorded before the field existed
    // was a promise.
    const r = objectiveRollup([obj({ progress: 50 })], "pi1");
    expect(r.committed).toHaveLength(1);
    expect(r.committedProgress).toBe(50);
  });

  it("returns null rather than 0% when nothing was committed", () => {
    // An increment with no commitment has no completion to report, and 0%
    // reads as total failure rather than as an empty plan.
    const r = objectiveRollup([obj({ progress: 40, committed: false })], "pi1");
    expect(r.committedProgress).toBeNull();
    expect(r.met).toBe(0);
  });

  it("counts only fully met committed objectives", () => {
    const r = objectiveRollup(
      [obj({ progress: 100 }), obj({ progress: 99 }), obj({ progress: 100, committed: false })],
      "pi1",
    );
    expect(r.met).toBe(1);
  });

  it("ignores objectives belonging to another increment", () => {
    const r = objectiveRollup(
      [obj({ progress: 100 }), obj({ progress: 0, intervalId: "pi2" })],
      "pi1",
    );
    expect(r.committed).toHaveLength(1);
    expect(r.committedProgress).toBe(100);
  });
});
