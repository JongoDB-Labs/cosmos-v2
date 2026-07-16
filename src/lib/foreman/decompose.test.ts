import { describe, it, expect } from "vitest";
import {
  judgeScope,
  planDecomposition,
  EPIC_MIN_ACCEPTANCE_CRITERIA,
  EPIC_DIFF_LINE_THRESHOLD,
  type ScopeSignals,
} from "./decompose";

const feature = (over: Partial<ScopeSignals> = {}): ScopeSignals => ({
  classification: "FEATURE",
  acceptanceCriteria: [],
  ...over,
});

const acs = (n: number): string[] => Array.from({ length: n }, (_, i) => `criterion ${i + 1}`);

describe("judgeScope — epic threshold (AC8: scope-judge threshold)", () => {
  it("marks a ticket epic when it has enough acceptance criteria", () => {
    const v = judgeScope(feature({ acceptanceCriteria: acs(EPIC_MIN_ACCEPTANCE_CRITERIA) }));
    expect(v.isEpic).toBe(true);
    expect(v.phaseCount).toBe(EPIC_MIN_ACCEPTANCE_CRITERIA);
    expect(v.reasons.join(" ")).toMatch(/acceptance criteria/);
  });

  it("marks a ticket epic on breadth (touched areas) even with few criteria", () => {
    const v = judgeScope(feature({ acceptanceCriteria: acs(2), touchedAreas: 4 }));
    expect(v.isEpic).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/touched areas/);
  });

  it("marks a ticket epic on expected diff size over the >400-line boundary", () => {
    const v = judgeScope(feature({ acceptanceCriteria: acs(2), expectedDiffLines: EPIC_DIFF_LINE_THRESHOLD + 1 }));
    expect(v.isEpic).toBe(true);
  });

  it("honours the oversize auto-park backstop", () => {
    const v = judgeScope(feature({ acceptanceCriteria: acs(2), oversizedBackstop: true }));
    expect(v.isEpic).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/backstop/);
  });
});

describe("judgeScope — no false splits (AC2/AC6)", () => {
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

describe("planDecomposition — output shape, ordering, deps (AC8: decomposition output)", () => {
  it("splits an epic FEATURE into ordered phases, one per criterion", () => {
    const plan = planDecomposition(feature({ acceptanceCriteria: acs(3), touchedAreas: 5 }));
    expect(plan).not.toBeNull();
    expect(plan!.phases.map((p) => p.phase)).toEqual([1, 2, 3]);
    // each phase carries exactly its own one criterion, in order
    expect(plan!.phases.map((p) => p.acceptanceCriteria)).toEqual([
      ["criterion 1"],
      ["criterion 2"],
      ["criterion 3"],
    ]);
  });

  it("sets dependency edges so phase N ships after phase N-1", () => {
    const plan = planDecomposition(feature({ acceptanceCriteria: acs(4) }));
    expect(plan!.phases.map((p) => p.dependsOnPhase)).toEqual([null, 1, 2, 3]);
  });

  it("coordinates a multi-phase FEATURE epic as a MINOR bump (AC4)", () => {
    const plan = planDecomposition(feature({ acceptanceCriteria: acs(4) }));
    expect(plan!.coordinate).toBe(true);
    expect(plan!.childClassification).toBe("FEATURE");
    expect(plan!.bumpKind).toBe("minor");
  });

  it("returns null for a non-epic ticket (no split, AC2/AC6)", () => {
    expect(planDecomposition(feature({ acceptanceCriteria: acs(2), expectedDiffLines: 20 }))).toBeNull();
  });

  it("does NOT auto-decompose a BUG, even an epic-sized one", () => {
    expect(planDecomposition({ classification: "BUG", acceptanceCriteria: acs(6) })).toBeNull();
  });
});
