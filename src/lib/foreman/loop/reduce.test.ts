// @vitest-environment node
import { describe, it, expect } from "vitest";
import { reduce } from "./reduce";
import { initialState } from "./state";
import type { TicketBrief } from "@/lib/foreman/prompt";

const brief: TicketBrief = { key: "C-1", title: "t", description: "", classification: "BUG", acceptanceCriteria: [] };
const base = () => initialState("id", "o", brief, 0);

describe("reduce", () => {
  it("is deterministic and immutable", () => {
    const s = base();
    const a = reduce(s, { kind: "build_done", sha: "abc", sessionRef: "sess", costUsd: 1, turnOverflow: false });
    const b = reduce(s, { kind: "build_done", sha: "abc", sessionRef: "sess", costUsd: 1, turnOverflow: false });
    expect(a).toEqual(b);
    expect(s.phase).toBe("queued");
  });
  it("build_done -> checks, increments attempts, accumulates cost, records session", () => {
    const s = reduce(base(), { kind: "build_done", sha: "abc", sessionRef: "sess", costUsd: 2.5, turnOverflow: false });
    expect(s.phase).toBe("checks");
    expect(s.attempts).toBe(1);
    expect(s.costUsd).toBe(2.5);
    expect(s.sessionRef).toBe("sess");
    expect(s.iteration).toBe(1);
  });
  it("build_done with turnOverflow -> resuming, increments turnResumes", () => {
    const s = reduce(base(), { kind: "build_done", sha: null, sessionRef: "sess", costUsd: 1, turnOverflow: true });
    expect(s.phase).toBe("resuming");
    expect(s.turnResumes).toBe(1);
  });
  it("checks_done passed -> review, resets noProgressRounds", () => {
    const s = reduce({ ...base(), phase: "checks", noProgressRounds: 2 }, { kind: "checks_done", passed: true, signature: "sigA" });
    expect(s.phase).toBe("review");
    expect(s.noProgressRounds).toBe(0);
  });
  it("checks_done failed with SAME signature -> increments noProgressRounds", () => {
    const s = reduce({ ...base(), phase: "checks", lastCheckSignature: "sigA", noProgressRounds: 1 }, { kind: "checks_done", passed: false, signature: "sigA" });
    expect(s.phase).toBe("repair");
    expect(s.noProgressRounds).toBe(2);
  });
  it("checks_done failed with NEW signature -> resets noProgressRounds", () => {
    const s = reduce({ ...base(), phase: "checks", lastCheckSignature: "sigA", noProgressRounds: 2 }, { kind: "checks_done", passed: false, signature: "sigB" });
    expect(s.noProgressRounds).toBe(0);
  });
  it("review_done approved -> shipping; rejected -> repair", () => {
    expect(reduce({ ...base(), phase: "review" }, { kind: "review_done", approved: true, reason: "ok" }).phase).toBe("shipping");
    expect(reduce({ ...base(), phase: "review" }, { kind: "review_done", approved: false, reason: "no" }).phase).toBe("repair");
  });
  it("shipped -> done; parked/fatal -> parked with signal", () => {
    expect(reduce({ ...base(), phase: "shipping" }, { kind: "shipped", version: "2.99.0" })).toMatchObject({ phase: "done", terminationSignal: "shipped" });
    expect(reduce(base(), { kind: "parked", signal: "stall", reason: "stuck" })).toMatchObject({ phase: "parked", terminationSignal: "stall" });
    expect(reduce(base(), { kind: "fatal", reason: "worktree gone" })).toMatchObject({ phase: "parked", terminationSignal: "fatal" });
  });
});
