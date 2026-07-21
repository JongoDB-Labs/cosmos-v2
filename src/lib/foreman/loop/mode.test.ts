// @vitest-environment node
import { describe, it, expect } from "vitest";
import { coerceLoopMode, defaultLoopSettings } from "./mode";

describe("coerceLoopMode", () => {
  it("accepts off/shadow/live", () => {
    expect(coerceLoopMode("off")).toBe("off");
    expect(coerceLoopMode("shadow")).toBe("shadow");
    expect(coerceLoopMode("live")).toBe("live");
  });
  it("defaults unknown/garbage to off", () => {
    expect(coerceLoopMode("")).toBe("off");
    expect(coerceLoopMode("banana")).toBe("off");
  });
});

describe("defaultLoopSettings", () => {
  it("is off with the daemon's current caps as budgets", () => {
    const s = defaultLoopSettings();
    expect(s.mode).toBe("off");
    expect(s.budgets.maxAttempts).toBe(3);
    expect(s.budgets.maxTurnResumes).toBe(30);
    expect(s.budgets.maxIterations).toBe(100);
    expect(s.budgets.stallRounds).toBe(3);
  });
});
