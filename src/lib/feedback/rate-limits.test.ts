import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTAKE_LIMITS,
  duplicateSignature,
  estimateBuildCost,
  planIntake,
  readIntakeLimits,
  throttleMessage,
  type IntakeCandidate,
  type IntakeLimits,
} from "./rate-limits";

/**
 * Pure-planner coverage for the intake rate-limits + abuse throttling (COSMOS-119,
 * Phase 3a). The full `runFeedbackRemediation` wiring (queue-depth query, submitter
 * notification, item stays OPEN) is covered against the real e2e DB in
 * remediate.test.ts; this file pins the deterministic decision logic.
 */

const LIMITS: IntakeLimits = {
  perUserPerRun: 100,
  perOrgPerRun: 100,
  maxQueueDepth: 100,
  buildBudget: 100,
};

function candidate(overrides: Partial<IntakeCandidate> & { id: string }): IntakeCandidate {
  return {
    authorId: "u1",
    type: "BUG",
    title: `title ${overrides.id}`,
    description: `desc ${overrides.id}`,
    ...overrides,
  };
}

describe("readIntakeLimits", () => {
  it("returns the permissive defaults for absent / malformed settings", () => {
    expect(readIntakeLimits(undefined)).toEqual(DEFAULT_INTAKE_LIMITS);
    expect(readIntakeLimits(null)).toEqual(DEFAULT_INTAKE_LIMITS);
    expect(readIntakeLimits({ intakeLimits: "nope" })).toEqual(DEFAULT_INTAKE_LIMITS);
    expect(readIntakeLimits({ intakeLimits: [] })).toEqual(DEFAULT_INTAKE_LIMITS);
  });

  it("reads and clamps configured caps to non-negative integers", () => {
    const cfg = readIntakeLimits({
      intakeLimits: { perUserPerRun: 2, perOrgPerRun: 5.7, maxQueueDepth: -3, buildBudget: "x" },
    });
    expect(cfg.perUserPerRun).toBe(2);
    expect(cfg.perOrgPerRun).toBe(6); // rounded
    expect(cfg.maxQueueDepth).toBe(0); // negatives floored to 0
    expect(cfg.buildBudget).toBe(DEFAULT_INTAKE_LIMITS.buildBudget); // non-number → default
  });
});

describe("estimateBuildCost", () => {
  it("charges a FEATURE more than a BUG", () => {
    expect(estimateBuildCost({ type: "FEATURE" })).toBeGreaterThan(estimateBuildCost({ type: "BUG" }));
  });
});

describe("duplicateSignature", () => {
  it("collapses case / punctuation / whitespace so near-duplicates match", () => {
    expect(duplicateSignature({ title: "Add Dark Mode!!!", description: "please" })).toBe(
      duplicateSignature({ title: "add   dark mode", description: "PLEASE." }),
    );
  });

  it("keeps genuinely different requests distinct", () => {
    expect(duplicateSignature({ title: "dark mode", description: "" })).not.toBe(
      duplicateSignature({ title: "light mode", description: "" }),
    );
  });
});

describe("planIntake", () => {
  it("admits everything when no cap bites", () => {
    const items = [candidate({ id: "a" }), candidate({ id: "b", authorId: "u2" })];
    const plan = planIntake(items, { queueDepth: 0 }, LIMITS);
    expect(plan.admit).toEqual(["a", "b"]);
    expect(plan.throttled).toEqual([]);
  });

  it("enforces the per-user cap (other users unaffected)", () => {
    const items = [
      candidate({ id: "a", authorId: "u1", title: "one" }),
      candidate({ id: "b", authorId: "u1", title: "two" }),
      candidate({ id: "c", authorId: "u2", title: "three" }),
    ];
    const plan = planIntake(items, { queueDepth: 0 }, { ...LIMITS, perUserPerRun: 1 });
    expect(plan.admit).toEqual(["a", "c"]);
    expect(plan.throttled).toEqual([{ id: "b", reason: "per-user-cap" }]);
  });

  it("enforces the per-org cap across all users", () => {
    const items = [
      candidate({ id: "a", authorId: "u1", title: "one" }),
      candidate({ id: "b", authorId: "u2", title: "two" }),
    ];
    const plan = planIntake(items, { queueDepth: 0 }, { ...LIMITS, perOrgPerRun: 1 });
    expect(plan.admit).toEqual(["a"]);
    expect(plan.throttled).toEqual([{ id: "b", reason: "per-org-cap" }]);
  });

  it("enforces the queue-depth cap using the existing in-flight depth", () => {
    const items = [candidate({ id: "a", title: "one" }), candidate({ id: "b", title: "two" })];
    // 4 already in flight, ceiling 5 → exactly one free slot.
    const plan = planIntake(items, { queueDepth: 4 }, { ...LIMITS, maxQueueDepth: 5 });
    expect(plan.admit).toEqual(["a"]);
    expect(plan.throttled).toEqual([{ id: "b", reason: "queue-depth" }]);
  });

  it("throttles everything when the queue is already at the ceiling", () => {
    const items = [candidate({ id: "a", title: "one" })];
    const plan = planIntake(items, { queueDepth: 9 }, { ...LIMITS, maxQueueDepth: 5 });
    expect(plan.admit).toEqual([]);
    expect(plan.throttled).toEqual([{ id: "a", reason: "queue-depth" }]);
  });

  it("enforces the build-cost budget (features spend it faster)", () => {
    const items = [
      candidate({ id: "a", type: "FEATURE", title: "one" }),
      candidate({ id: "b", type: "FEATURE", title: "two" }),
    ];
    // Budget 3: first FEATURE costs 2 (total 2, ok), second would be 4 (> 3).
    const plan = planIntake(items, { queueDepth: 0 }, { ...LIMITS, buildBudget: 3 });
    expect(plan.admit).toEqual(["a"]);
    expect(plan.throttled).toEqual([{ id: "b", reason: "build-budget" }]);
  });

  it("throttles a near-duplicate flood, admitting only the first of each signature", () => {
    const items = [
      candidate({ id: "a", title: "App crashes on save", description: "boom" }),
      candidate({ id: "b", title: "app CRASHES on save!", description: "Boom." }),
      candidate({ id: "c", title: "app crashes on   save", description: "boom" }),
      candidate({ id: "d", title: "unrelated request", description: "other" }),
    ];
    const plan = planIntake(items, { queueDepth: 0 }, LIMITS);
    expect(plan.admit).toEqual(["a", "d"]);
    expect(plan.throttled).toEqual([
      { id: "b", reason: "duplicate-flood" },
      { id: "c", reason: "duplicate-flood" },
    ]);
  });

  it("flood-throttles copies even when the lead item is itself capped", () => {
    // A whole flood shares one signature; the lead trips the per-org cap, the rest
    // must still be flood-throttled rather than sneaking in behind it.
    const items = [
      candidate({ id: "seed", authorId: "u0", title: "seed", description: "x" }),
      candidate({ id: "a", authorId: "u1", title: "spam", description: "same" }),
      candidate({ id: "b", authorId: "u2", title: "spam", description: "same" }),
    ];
    const plan = planIntake(items, { queueDepth: 0 }, { ...LIMITS, perOrgPerRun: 1 });
    expect(plan.admit).toEqual(["seed"]);
    expect(plan.throttled).toEqual([
      { id: "a", reason: "per-org-cap" },
      { id: "b", reason: "duplicate-flood" },
    ]);
  });
});

describe("throttleMessage", () => {
  it("gives a duplicate-specific message and a generic queued message", () => {
    expect(throttleMessage("duplicate-flood")).toMatch(/duplicate/i);
    expect(throttleMessage("per-user-cap")).toMatch(/queued/i);
    expect(throttleMessage("queue-depth")).toMatch(/queued/i);
  });
});
