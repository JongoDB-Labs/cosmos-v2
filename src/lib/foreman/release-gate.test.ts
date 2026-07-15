import { describe, it, expect } from "vitest";
import {
  coordinationModeFromTags,
  batchMergeOrder,
  decideRelease,
  aggregateReadiness,
  DEFAULT_COORDINATION_MODE,
  DEFAULT_PARTIAL_FAILURE_POLICY,
  COORDINATED_RELEASE_TAG,
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
