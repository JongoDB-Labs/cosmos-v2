// @vitest-environment node
import { describe, it, expect } from "vitest";
import { decideNext } from "./transitions";
import { initialState, type Observation, type LoopState } from "./state";
import type { TicketBrief } from "@/lib/foreman/prompt";

const brief: TicketBrief = { key: "C-1", title: "t", description: "", classification: "BUG", acceptanceCriteria: [] };
const s = (phase: LoopState["phase"]) => ({ ...initialState("id", "o", brief, 0), phase });
const obs = (o: Partial<Observation>): Observation => ({ hasDiff: false, diffHash: null, checksPassed: null, checkSignature: null, progressed: true, needsHumanInput: false, ...o });

describe("decideNext", () => {
  it("builds from queued", () => { expect(decideNext(s("queued"), obs({})).kind).toBe("build"); });
  it("runs checks after building", () => { expect(decideNext(s("building"), obs({})).kind).toBe("run_checks"); });
  it("reviews when checks passed", () => { expect(decideNext(s("checks"), obs({ checksPassed: true })).kind).toBe("review"); });
  it("repairs when checks failed", () => { expect(decideNext(s("checks"), obs({ checksPassed: false })).kind).toBe("repair"); });
  it("re-runs checks when not yet run", () => { expect(decideNext(s("checks"), obs({ checksPassed: null })).kind).toBe("run_checks"); });
  it("ships after a passing review", () => { expect(decideNext(s("review"), obs({})).kind).toBe("ship"); });
  it("parks for human input regardless of phase", () => {
    expect(decideNext(s("building"), obs({ needsHumanInput: true }))).toMatchObject({ kind: "park", signal: "parked_for_human" });
  });
});
