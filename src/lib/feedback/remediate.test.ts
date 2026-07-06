import { describe, expect, it } from "vitest";
import { heuristicTriage } from "./remediate";

/**
 * Guardrail coverage for the fallback classifier — this is what runs when AI
 * triage is unavailable, so the auto-remediation loop keeps delivering feedback
 * into the backlog even with no model configured (the common case for a fresh
 * org). The full loop (delivery, idempotency, config gating) is covered by the
 * e2e verification against a live DB.
 */
describe("heuristicTriage — AI-unavailable fallback", () => {
  it("keeps a bug a BUG and raises severity when there's an error signature", () => {
    const t = heuristicTriage({
      type: "BUG",
      telemetry: { stack: "TypeError: x is undefined", route: "/issues" },
    });
    expect(t.classification).toBe("BUG");
    expect(t.severity).toBe("high");
    expect(t.source).toBe("heuristic");
  });

  it("a bug WITHOUT error telemetry stays medium", () => {
    const t = heuristicTriage({ type: "BUG", telemetry: {} });
    expect(t.classification).toBe("BUG");
    expect(t.severity).toBe("medium");
  });

  it("treats errorSignature / digest as an error signal too", () => {
    expect(heuristicTriage({ type: "BUG", telemetry: { errorSignature: "abc" } }).severity).toBe("high");
    expect(heuristicTriage({ type: "BUG", telemetry: { digest: "123" } }).severity).toBe("high");
  });

  it("a feature request is FEATURE / medium regardless of telemetry", () => {
    const t = heuristicTriage({ type: "FEATURE", telemetry: { stack: "noise" } });
    expect(t.classification).toBe("FEATURE");
    expect(t.severity).toBe("medium");
  });

  it("tolerates null/odd telemetry without throwing", () => {
    expect(() => heuristicTriage({ type: "FEATURE", telemetry: null })).not.toThrow();
    expect(heuristicTriage({ type: "FEATURE", telemetry: null }).acceptanceCriteria).toEqual([]);
  });
});
