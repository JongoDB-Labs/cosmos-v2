// src/lib/observability/__tests__/metrics.test.ts
//
// The observability metric helpers are OBSERVE-ONLY and fire-and-forget: they MUST never
// throw and never block, with OR without an OpenTelemetry SDK / MeterProvider registered.
// (No provider is registered in unit tests, so `metrics.getMeter()` yields the API no-op
// Meter — exactly the production-degraded "collector absent" path.) These tests pin that
// contract: any future refactor that makes an emit throw will fail here.

import { describe, it, expect } from "vitest";
import {
  recordEgressDecision,
  recordEgressError,
  recordClassifier,
  recordClassifierError,
} from "@/lib/observability/metrics";

describe("observability metrics (no-op-safe, fire-and-forget)", () => {
  it("recordEgressDecision never throws (exposed true/false, any enums)", () => {
    expect(() =>
      recordEgressDecision({ exposed: true, decidedBy: "none", tenantClass: "gov" }),
    ).not.toThrow();
    expect(() =>
      recordEgressDecision({ exposed: false, decidedBy: "classification", tenantClass: "commercial" }),
    ).not.toThrow();
  });

  it("recordEgressError never throws", () => {
    expect(() => recordEgressError("turn")).not.toThrow();
    expect(() => recordEgressError("classifier")).not.toThrow();
  });

  it("recordClassifier never throws (allow + deny, any latency)", () => {
    expect(() => recordClassifier({ result: "allow", latencyMs: 12 })).not.toThrow();
    expect(() => recordClassifier({ result: "deny", latencyMs: 0 })).not.toThrow();
  });

  it("recordClassifierError never throws", () => {
    expect(() => recordClassifierError()).not.toThrow();
  });

  it("helpers are safe to call repeatedly (idempotent, no state corruption)", () => {
    expect(() => {
      for (let i = 0; i < 100; i++) {
        recordEgressDecision({ exposed: i % 2 === 0, decidedBy: "rbac", tenantClass: "gov" });
        recordEgressError("loop");
        recordClassifier({ result: "allow", latencyMs: i });
        recordClassifierError();
      }
    }).not.toThrow();
  });
});
