// @vitest-environment node
import { describe, it, expect } from "vitest";
import { translate } from "./translate";

describe("translate", () => {
  it("maps built -> build_done carrying sha/session/overflow", () => {
    expect(translate({ kind: "built", sha: "abc", sessionRef: "s", turnOverflow: false }))
      .toEqual({ kind: "build_done", sha: "abc", sessionRef: "s", costUsd: 0, turnOverflow: false });
  });
  it("maps checks -> checks_done with pass/fail + signature", () => {
    expect(translate({ kind: "checks", passed: false, signature: "sigA" }))
      .toEqual({ kind: "checks_done", passed: false, signature: "sigA" });
  });
  it("maps repaired -> repair_done", () => {
    expect(translate({ kind: "repaired", sha: "def" })).toEqual({ kind: "repair_done", sha: "def", costUsd: 0 });
  });
  it("maps reviewed -> review_done", () => {
    expect(translate({ kind: "reviewed", approved: true, reason: "ok" })).toEqual({ kind: "review_done", approved: true, reason: "ok" });
  });
  it("maps shipped -> shipped", () => {
    expect(translate({ kind: "shipped", version: "2.99.0" })).toEqual({ kind: "shipped", version: "2.99.0" });
  });
  it("maps parked -> parked with parked_for_human", () => {
    expect(translate({ kind: "parked", humanReason: "needs input" })).toEqual({ kind: "parked", signal: "parked_for_human", reason: "needs input" });
  });
  it("maps delivered_nooploop -> shipped (delivered)", () => {
    expect(translate({ kind: "delivered_nooploop" })).toEqual({ kind: "shipped", version: "delivered" });
  });
  it("maps infra_failed -> fatal", () => {
    expect(translate({ kind: "infra_failed", reason: "worktree" })).toEqual({ kind: "fatal", reason: "worktree" });
  });
});
