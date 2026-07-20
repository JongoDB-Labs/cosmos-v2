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
  it("runs checks from the checks phase", () => { expect(decideNext(s("checks"), obs({})).kind).toBe("run_checks"); });
  it("invokes repair from the repair phase (not run_checks)", () => { expect(decideNext(s("repair"), obs({})).kind).toBe("repair"); });
  it("resumes from the resuming phase (not run_checks)", () => { expect(decideNext(s("resuming"), obs({})).kind).toBe("resume"); });
  it("reviews from the review phase", () => { expect(decideNext(s("review"), obs({})).kind).toBe("review"); });
  it("ships from the shipping phase", () => { expect(decideNext(s("shipping"), obs({})).kind).toBe("ship"); });
  it("noops from terminal phases", () => {
    expect(decideNext(s("done"), obs({})).kind).toBe("noop");
    expect(decideNext(s("parked"), obs({})).kind).toBe("noop");
  });
  it("parks for human input regardless of phase", () => {
    expect(decideNext(s("checks"), obs({ needsHumanInput: true }))).toMatchObject({ kind: "park", signal: "parked_for_human" });
  });
});
