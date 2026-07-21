// @vitest-environment node
import { describe, it, expect } from "vitest";
import { observe, type RawFacts } from "./observe";
import { initialState } from "./state";
import type { TicketBrief } from "@/lib/foreman/prompt";

const brief: TicketBrief = { key: "C-1", title: "t", description: "", classification: "BUG", acceptanceCriteria: [] };
const facts = (o: Partial<RawFacts>): RawFacts => ({ diff: null, checksPassed: null, checkLog: null, needsHumanInput: false, ...o });

describe("observe", () => {
  it("reports progressed when the diff hash differs from last iteration", () => {
    const s = { ...initialState("id", "o", brief, 0), lastDiffHash: "old" };
    const obs = observe(s, facts({ diff: "new code" }));
    expect(obs.hasDiff).toBe(true);
    expect(obs.progressed).toBe(true);
  });
  it("reports NOT progressed when diff hash and check signature are unchanged", () => {
    const first = observe(initialState("id", "o", brief, 0), facts({ diff: "x", checkLog: "error at line 1" }));
    const s = { ...initialState("id", "o", brief, 0), lastDiffHash: first.diffHash, lastCheckSignature: first.checkSignature };
    const obs = observe(s, facts({ diff: "x", checkLog: "error at line 1" }));
    expect(obs.progressed).toBe(false);
  });
  it("passes through needsHumanInput and checksPassed", () => {
    const obs = observe(initialState("id", "o", brief, 0), facts({ checksPassed: true, needsHumanInput: true }));
    expect(obs.checksPassed).toBe(true);
    expect(obs.needsHumanInput).toBe(true);
  });
});
