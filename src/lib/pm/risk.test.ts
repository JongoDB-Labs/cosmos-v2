import { describe, it, expect } from "vitest";
import { computeRiskScore, riskLevelFromScore } from "./risk";

describe("computeRiskScore", () => {
  it("multiplies likelihood by impact", () => {
    expect(computeRiskScore(4, 5)).toBe(20);
    expect(computeRiskScore(3, 4)).toBe(12);
    expect(computeRiskScore(1, 1)).toBe(1);
  });
});

describe("riskLevelFromScore", () => {
  it("bands scores into severity levels at the boundaries", () => {
    expect(riskLevelFromScore(25)).toBe("CRITICAL");
    expect(riskLevelFromScore(20)).toBe("CRITICAL");
    expect(riskLevelFromScore(19)).toBe("HIGH");
    expect(riskLevelFromScore(12)).toBe("HIGH");
    expect(riskLevelFromScore(11)).toBe("MEDIUM");
    expect(riskLevelFromScore(6)).toBe("MEDIUM");
    expect(riskLevelFromScore(5)).toBe("LOW");
    expect(riskLevelFromScore(1)).toBe("LOW");
  });
});
