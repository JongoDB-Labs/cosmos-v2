import { describe, it, expect } from "vitest";
import {
  coordinationModeFromTags,
  batchMergeOrder,
  decideRelease,
  aggregateReadiness,
  childReadiness,
  phaseIndexFromTags,
  DEFAULT_COORDINATION_MODE,
  DEFAULT_PARTIAL_FAILURE_POLICY,
  COORDINATED_RELEASE_TAG,
  COORDINATED_READY_TAG,
  COORDINATED_FAILED_TAG,
  COORDINATED_PHASE_TAG_PREFIX,
  type Sibling,
} from "./release-gate";

const s = (key: string, readiness: Sibling["readiness"], dependsOn?: string[]): Sibling => ({
  key,
  readiness,
  ...(dependsOn ? { dependsOn } : {}),
});

describe("coordinationModeFromTags", () => {
  it("defaults to incremental (safe default) when the opt-in tag is absent", () => {
    expect(coordinationModeFromTags([])).toBe("incremental");
    expect(coordinationModeFromTags(["urgent", "backend"])).toBe("incremental");
    expect(DEFAULT_COORDINATION_MODE).toBe("incremental");
  });

  it("is coordinated only when the epic carries the opt-in tag", () => {
    expect(coordinationModeFromTags([COORDINATED_RELEASE_TAG])).toBe("coordinated");
    expect(coordinationModeFromTags(["x", COORDINATED_RELEASE_TAG, "y"])).toBe("coordinated");
  });
});

describe("childReadiness — approved-held maps to ready (AC8: readiness mapping)", () => {
  it("a shipped/done child is ready", () => {
    expect(childReadiness("done", [])).toBe("ready");
  });

  it("a green+approved child HELD in review is ready via its approval marker (the COSMOS-118 fix)", () => {
    // The bug: a held-in-review child was only ever 'pending' (column !== done),
    // so the batch never fired. The approve marker makes it read 'ready'.
    expect(childReadiness("review", [COORDINATED_READY_TAG])).toBe("ready");
  });

  it("an in-flight child (not done, no marker) is pending", () => {
    expect(childReadiness("review", [])).toBe("pending");
    expect(childReadiness("in-progress", ["some-other-tag"])).toBe("pending");
  });

  it("a terminally-failed child is failed, and failure wins over a stale ready marker", () => {
    expect(childReadiness("review", [COORDINATED_FAILED_TAG])).toBe("failed");
    expect(childReadiness("review", [COORDINATED_READY_TAG, COORDINATED_FAILED_TAG])).toBe("failed");
  });
});

describe("phaseIndexFromTags — dependency-order edges", () => {
  it("reads the 1-based phase index from the phase tag", () => {
    expect(phaseIndexFromTags([`${COORDINATED_PHASE_TAG_PREFIX}1`])).toBe(1);
    expect(phaseIndexFromTags(["x", `${COORDINATED_PHASE_TAG_PREFIX}3`, "y"])).toBe(3);
  });

  it("is null when unphased or malformed", () => {
    expect(phaseIndexFromTags([])).toBeNull();
    expect(phaseIndexFromTags(["urgent"])).toBeNull();
    expect(phaseIndexFromTags([`${COORDINATED_PHASE_TAG_PREFIX}0`])).toBeNull();
    expect(phaseIndexFromTags([`${COORDINATED_PHASE_TAG_PREFIX}x`])).toBeNull();
  });
});

describe("decideRelease — coordination gate holds then releases (AC1)", () => {
  it("HOLDS while any sibling is still pending, even if others are ready", () => {
    const d = decideRelease({
      mode: "coordinated",
      siblings: [s("COSMOS-2", "ready"), s("COSMOS-3", "pending"), s("COSMOS-4", "ready")],
    });
    expect(d.action).toBe("hold");
    expect(d.batch).toEqual([]); // nothing ships while held
    expect(d.reason).toMatch(/waiting on COSMOS-3/);
  });

  it("RELEASES the whole batch once every phase is green+approved", () => {
    const d = decideRelease({
      mode: "coordinated",
      siblings: [s("COSMOS-2", "ready"), s("COSMOS-3", "ready"), s("COSMOS-4", "ready")],
    });
    expect(d.action).toBe("release");
    expect(d.batch).toEqual(["COSMOS-2", "COSMOS-3", "COSMOS-4"]);
    expect(d.reason).toMatch(/one coordinated release/);
  });
});

describe("decideRelease — batched merge + single version, in dependency order (AC1)", () => {
  it("orders the release batch by dependency, not discovery order", () => {
    // 4 depends on 3, which depends on 2 → merge 2, 3, 4 (then 5 independent).
    const d = decideRelease({
      mode: "coordinated",
      siblings: [
        s("COSMOS-4", "ready", ["COSMOS-3"]),
        s("COSMOS-2", "ready"),
        s("COSMOS-5", "ready"),
        s("COSMOS-3", "ready", ["COSMOS-2"]),
      ],
    });
    expect(d.action).toBe("release");
    // A single ordered batch (one version bump / tag / deploy) — dependency-first.
    expect(d.batch.indexOf("COSMOS-2")).toBeLessThan(d.batch.indexOf("COSMOS-3"));
    expect(d.batch.indexOf("COSMOS-3")).toBeLessThan(d.batch.indexOf("COSMOS-4"));
    expect(d.batch).toHaveLength(4);
  });
});

describe("batchMergeOrder", () => {
  it("is deterministic (stable key sort) when there are no dependencies", () => {
    expect(batchMergeOrder([s("COSMOS-30", "ready"), s("COSMOS-3", "ready"), s("COSMOS-12", "ready")])).toEqual([
      "COSMOS-12",
      "COSMOS-3",
      "COSMOS-30",
    ]);
  });

  it("places dependencies before dependents", () => {
    const order = batchMergeOrder([s("B", "ready", ["A"]), s("C", "ready", ["B"]), s("A", "ready")]);
    expect(order).toEqual(["A", "B", "C"]);
  });

  it("ignores dependencies pointing outside the batch", () => {
    const order = batchMergeOrder([s("B", "ready", ["EXTERNAL-9"]), s("A", "ready")]);
    expect(order).toEqual(["A", "B"]);
  });

  it("is cycle-safe — never hangs or drops a node on a dependency cycle", () => {
    const order = batchMergeOrder([s("A", "ready", ["B"]), s("B", "ready", ["A"])]);
    expect(order.sort()).toEqual(["A", "B"]);
  });
});

describe("decideRelease — incremental / non-epic fallthrough (AC2)", () => {
  it("incremental epics ship the ready set per-ticket (no coordination)", () => {
    const d = decideRelease({
      mode: "incremental",
      siblings: [s("COSMOS-2", "ready"), s("COSMOS-3", "pending")],
    });
    expect(d.action).toBe("release");
    expect(d.batch).toEqual(["COSMOS-2"]); // only the ready one, shipped now
    expect(d.reason).toMatch(/per ticket/);
  });

  it("a solo child (single-item) ships immediately under incremental", () => {
    const d = decideRelease({ mode: "incremental", siblings: [s("COSMOS-9", "ready")] });
    expect(d.action).toBe("release");
    expect(d.batch).toEqual(["COSMOS-9"]);
  });
});

describe("decideRelease — partial-failure handling (AC3)", () => {
  it("hold-all (default): a failed sibling aborts the whole coordinated release", () => {
    expect(DEFAULT_PARTIAL_FAILURE_POLICY).toBe("hold-all");
    const d = decideRelease({
      mode: "coordinated",
      siblings: [s("COSMOS-2", "ready"), s("COSMOS-3", "failed"), s("COSMOS-4", "ready")],
    });
    expect(d.action).toBe("abort");
    expect(d.batch).toEqual([]); // never a silent half-release
    expect(d.reason).toMatch(/hold-all/);
    expect(d.reason).toMatch(/COSMOS-3/);
  });

  it("ship-ready-subset: ships only the green+approved subset, clearly surfaced", () => {
    const d = decideRelease({
      mode: "coordinated",
      policy: "ship-ready-subset",
      siblings: [s("COSMOS-2", "ready"), s("COSMOS-3", "failed"), s("COSMOS-4", "ready")],
    });
    expect(d.action).toBe("release");
    expect(d.batch).toEqual(["COSMOS-2", "COSMOS-4"]);
    expect(d.reason).toMatch(/skipping failed: COSMOS-3/);
  });

  it("ship-ready-subset with nothing ready aborts rather than silently doing nothing", () => {
    const d = decideRelease({
      mode: "coordinated",
      policy: "ship-ready-subset",
      siblings: [s("COSMOS-3", "failed"), s("COSMOS-4", "pending")],
    });
    expect(d.action).toBe("abort");
    expect(d.reason).toMatch(/no phase ready/);
  });
});

describe("aggregateReadiness — console surface", () => {
  it("summarises a holding coordinated epic", () => {
    const r = aggregateReadiness("coordinated", [s("A", "ready"), s("B", "pending"), s("C", "pending")]);
    expect(r).toMatchObject({ status: "holding", total: 3, ready: 1, pending: 2, failed: 0 });
    expect(r.label).toMatch(/holding/);
  });

  it("summarises a fully-ready coordinated epic as shipping", () => {
    const r = aggregateReadiness("coordinated", [s("A", "ready"), s("B", "ready")]);
    expect(r.status).toBe("shipping");
  });

  it("summarises a failed coordinated epic as blocked", () => {
    const r = aggregateReadiness("coordinated", [s("A", "ready"), s("B", "failed")]);
    expect(r.status).toBe("blocked");
  });

  it("summarises an incremental epic distinctly", () => {
    const r = aggregateReadiness("incremental", [s("A", "ready"), s("B", "pending")]);
    expect(r.status).toBe("incremental");
  });
});

import {
  coordinatedReleaseFingerprint,
  shouldRefireCoordinatedRelease,
  type FingerprintSibling,
} from "./release-gate";

describe("coordinatedReleaseFingerprint", () => {
  const sib = (over: Partial<FingerprintSibling>): FingerprintSibling => ({
    key: "COSMOS-1",
    readiness: "ready",
    tipSha: "aaa",
    ...over,
  });

  it("is order-independent", () => {
    const a = [sib({ key: "COSMOS-1" }), sib({ key: "COSMOS-2", tipSha: "bbb" })];
    const b = [sib({ key: "COSMOS-2", tipSha: "bbb" }), sib({ key: "COSMOS-1" })];
    expect(coordinatedReleaseFingerprint(a)).toBe(coordinatedReleaseFingerprint(b));
  });
  it("changes when a phase's tip SHA changes (a rebuild pushed a new tip)", () => {
    const before = [sib({ key: "COSMOS-1", tipSha: "aaa" })];
    const after = [sib({ key: "COSMOS-1", tipSha: "zzz" })];
    expect(coordinatedReleaseFingerprint(before)).not.toBe(coordinatedReleaseFingerprint(after));
  });
  it("changes when a phase's readiness changes", () => {
    const pending = [sib({ readiness: "pending" })];
    const ready = [sib({ readiness: "ready" })];
    expect(coordinatedReleaseFingerprint(pending)).not.toBe(coordinatedReleaseFingerprint(ready));
  });
  it("is identical for the same state (no spurious re-fire)", () => {
    const s = [sib({ key: "COSMOS-1" }), sib({ key: "COSMOS-2", tipSha: "bbb" })];
    expect(coordinatedReleaseFingerprint(s)).toBe(coordinatedReleaseFingerprint([...s]));
  });
});

describe("shouldRefireCoordinatedRelease", () => {
  const release = { action: "release" as const, batch: ["COSMOS-1"], reason: "" };
  const hold = { action: "hold" as const, batch: [], reason: "" };
  const abort = { action: "abort" as const, batch: [], reason: "" };

  it("fires when gate=release and the fingerprint changed", () => {
    expect(
      shouldRefireCoordinatedRelease({ decision: release, currentFingerprint: "b", lastAttemptFingerprint: "a" }),
    ).toBe(true);
  });
  it("fires the first time (no prior attempt)", () => {
    expect(
      shouldRefireCoordinatedRelease({ decision: release, currentFingerprint: "a", lastAttemptFingerprint: null }),
    ).toBe(true);
  });
  it("does NOT re-fire when the fingerprint is unchanged (no storm)", () => {
    expect(
      shouldRefireCoordinatedRelease({ decision: release, currentFingerprint: "a", lastAttemptFingerprint: "a" }),
    ).toBe(false);
  });
  it("never fires on hold or abort even if the fingerprint changed", () => {
    expect(
      shouldRefireCoordinatedRelease({ decision: hold, currentFingerprint: "b", lastAttemptFingerprint: "a" }),
    ).toBe(false);
    expect(
      shouldRefireCoordinatedRelease({ decision: abort, currentFingerprint: "b", lastAttemptFingerprint: "a" }),
    ).toBe(false);
  });
});
