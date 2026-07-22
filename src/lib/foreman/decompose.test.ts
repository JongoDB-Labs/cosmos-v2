import { describe, it, expect } from "vitest";
import {
  judgeScope,
  planDecomposition,
  alreadyDecomposed,
  EPIC_MIN_ACCEPTANCE_CRITERIA,
  EPIC_DIFF_LINE_THRESHOLD,
  EPIC_MIN_DESCRIPTION_CHARS,
  DECOMPOSED_TAG,
  type ScopeSignals,
} from "./decompose";

const feature = (over: Partial<ScopeSignals> = {}): ScopeSignals => ({
  classification: "FEATURE",
  acceptanceCriteria: [],
  ...over,
});

const acs = (n: number): string[] => Array.from({ length: n }, (_, i) => `criterion ${i + 1}`);

describe("judgeScope — epic threshold needs BOTH criteria + breadth (COSMOS-128 AC1/AC2)", () => {
  it("marks a ticket epic when it has enough criteria AND a breadth signal (touched areas)", () => {
    const v = judgeScope(feature({ acceptanceCriteria: acs(EPIC_MIN_ACCEPTANCE_CRITERIA), touchedAreas: 4 }));
    expect(v.isEpic).toBe(true);
    expect(v.phaseCount).toBe(EPIC_MIN_ACCEPTANCE_CRITERIA);
    expect(v.reasons.join(" ")).toMatch(/acceptance criteria/);
    expect(v.reasons.join(" ")).toMatch(/touched areas/);
  });

  it("marks a ticket epic on expected diff size over the >400-line boundary (with enough criteria)", () => {
    const v = judgeScope(feature({ acceptanceCriteria: acs(4), expectedDiffLines: EPIC_DIFF_LINE_THRESHOLD + 1 }));
    expect(v.isEpic).toBe(true);
  });

  it("marks a ticket epic on a long, multi-deliverable description (with enough criteria)", () => {
    const v = judgeScope(feature({ acceptanceCriteria: acs(4), descriptionLength: EPIC_MIN_DESCRIPTION_CHARS }));
    expect(v.isEpic).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/description/);
  });

  it("honours the oversize auto-park backstop (with enough criteria)", () => {
    const v = judgeScope(feature({ acceptanceCriteria: acs(4), oversizedBackstop: true }));
    expect(v.isEpic).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/backstop/);
  });
});

describe("judgeScope — no false splits (COSMOS-128 AC1)", () => {
  it("a normal small feature with 4+ criteria but NO breadth signal is NOT an epic", () => {
    const v = judgeScope(feature({ acceptanceCriteria: acs(EPIC_MIN_ACCEPTANCE_CRITERIA), descriptionLength: 120 }));
    expect(v.isEpic).toBe(false);
    expect(v.phaseCount).toBe(0);
    expect(v.reasons.join(" ")).toMatch(/no breadth\/size signal/);
  });

  it("many criteria (well above the threshold) still needs a breadth signal to split", () => {
    const v = judgeScope(feature({ acceptanceCriteria: acs(8) }));
    expect(v.isEpic).toBe(false);
  });

  it("breadth alone with too few criteria is NOT an epic", () => {
    const v = judgeScope(feature({ acceptanceCriteria: acs(2), touchedAreas: 9, expectedDiffLines: 5000 }));
    expect(v.isEpic).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/acceptance criteria/);
  });

  it("a small ticket with few criteria is NOT an epic", () => {
    const v = judgeScope(feature({ acceptanceCriteria: acs(2), expectedDiffLines: 40 }));
    expect(v.isEpic).toBe(false);
    expect(v.phaseCount).toBe(0);
  });

  it("a single-criterion ticket is never decomposable (nothing to order)", () => {
    const v = judgeScope(feature({ acceptanceCriteria: acs(1), touchedAreas: 9, expectedDiffLines: 5000 }));
    expect(v.isEpic).toBe(false);
  });

  it("zero criteria is never an epic", () => {
    expect(judgeScope(feature({ acceptanceCriteria: [] })).isEpic).toBe(false);
  });
});

describe("planDecomposition — output shape, ordering, deps (COSMOS-128 AC2)", () => {
  it("splits a genuinely epic FEATURE into ordered phases, one per criterion", () => {
    const plan = planDecomposition(feature({ acceptanceCriteria: acs(4), touchedAreas: 5, descriptionLength: EPIC_MIN_DESCRIPTION_CHARS }));
    expect(plan).not.toBeNull();
    expect(plan!.phases.map((p) => p.phase)).toEqual([1, 2, 3, 4]);
    // each phase carries exactly its own one criterion, in order
    expect(plan!.phases.map((p) => p.acceptanceCriteria)).toEqual([
      ["criterion 1"],
      ["criterion 2"],
      ["criterion 3"],
      ["criterion 4"],
    ]);
  });

  it("sets dependency edges so phase N ships after phase N-1", () => {
    const plan = planDecomposition(feature({ acceptanceCriteria: acs(4), touchedAreas: 4 }));
    expect(plan!.phases.map((p) => p.dependsOnPhase)).toEqual([null, 1, 2, 3]);
  });

  it("coordinates a multi-phase FEATURE epic as a MINOR bump", () => {
    const plan = planDecomposition(feature({ acceptanceCriteria: acs(4), touchedAreas: 4 }));
    expect(plan!.coordinate).toBe(true);
    expect(plan!.childClassification).toBe("FEATURE");
    expect(plan!.bumpKind).toBe("minor");
  });

  it("returns null for a non-epic ticket — 4+ criteria but no breadth (no false split, AC1)", () => {
    expect(planDecomposition(feature({ acceptanceCriteria: acs(4), descriptionLength: 80 }))).toBeNull();
  });

  it("returns null for a small ticket with few criteria (no split)", () => {
    expect(planDecomposition(feature({ acceptanceCriteria: acs(2), expectedDiffLines: 20 }))).toBeNull();
  });

  it("does NOT auto-decompose a BUG, even a genuinely epic-sized one", () => {
    expect(planDecomposition({ classification: "BUG", acceptanceCriteria: acs(6), touchedAreas: 8 })).toBeNull();
  });

  it("exports the decomposed tag used by the re-decomposition guard", () => {
    expect(DECOMPOSED_TAG).toBe("decomposed");
  });
});

describe("alreadyDecomposed — re-decomposition guard (COSMOS-128 AC3)", () => {
  it("is true for an epic already tagged `decomposed` (e.g. dragged back to backlog)", () => {
    expect(alreadyDecomposed([DECOMPOSED_TAG])).toBe(true);
    expect(alreadyDecomposed(["coordinated-release", DECOMPOSED_TAG, "feedback:feature"])).toBe(true);
  });

  it("is false for an epic that has never been decomposed", () => {
    expect(alreadyDecomposed([])).toBe(false);
    expect(alreadyDecomposed(["feedback:feature", "priority:high"])).toBe(false);
  });
});

import { stackedBase } from "./decompose";

describe("stackedBase", () => {
  it("bases phase 1 on origin/main", () => {
    expect(stackedBase(1, new Map())).toBe("origin/main");
    expect(stackedBase(1, new Map([[1, "auto/COSMOS-119"]]))).toBe("origin/main");
  });
  it("bases phase N on phase N-1's branch", () => {
    const branches = new Map([
      [1, "auto/COSMOS-119"],
      [2, "auto/COSMOS-120"],
    ]);
    expect(stackedBase(2, branches)).toBe("auto/COSMOS-119");
    expect(stackedBase(3, new Map([[2, "auto/COSMOS-120"]]))).toBe("auto/COSMOS-120");
  });
  it("falls back to origin/main when the predecessor branch isn't built yet", () => {
    expect(stackedBase(3, new Map([[1, "auto/COSMOS-119"]]))).toBe("origin/main");
    expect(stackedBase(2, new Map())).toBe("origin/main");
  });
});
