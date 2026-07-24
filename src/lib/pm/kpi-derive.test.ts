import { describe, it, expect } from "vitest";
import { applyKpiAutoValue, type ExecutionMetrics } from "./kpi-derive";

const metrics: ExecutionMetrics = {
  completionPct: 66,
  velocity: 41,
  openItems: 16,
  avgCycleTime: 9,
  throughput: (w) => (w === 30 ? 12 : 5),
};

describe("applyKpiAutoValue", () => {
  it("MANUAL → null so the stored value is kept", () => {
    expect(applyKpiAutoValue("MANUAL", null, metrics)).toBeNull();
  });
  it("VELOCITY → avg points per interval", () => {
    expect(applyKpiAutoValue("VELOCITY", null, metrics)).toBe(41);
  });
  it("COMPLETION_PCT → percent done", () => {
    expect(applyKpiAutoValue("COMPLETION_PCT", null, metrics)).toBe(66);
  });
  it("OPEN_ITEMS → not-done count", () => {
    expect(applyKpiAutoValue("OPEN_ITEMS", null, metrics)).toBe(16);
  });
  it("AVG_CYCLE_TIME → avg days", () => {
    expect(applyKpiAutoValue("AVG_CYCLE_TIME", null, metrics)).toBe(9);
  });
  it("THROUGHPUT uses the rolling window (default 30)", () => {
    expect(applyKpiAutoValue("THROUGHPUT", null, metrics)).toBe(12);
    expect(applyKpiAutoValue("THROUGHPUT", 7, metrics)).toBe(5);
  });
});
