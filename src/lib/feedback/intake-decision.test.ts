import { describe, expect, it } from "vitest";
import { describeIntakeDecision } from "./intake-decision";

/**
 * describeIntakeDecision maps a feedback item's recorded `triage` + delivery
 * marker into ONE display-ready descriptor (accepted / held / rejected /
 * throttled / gated + reason + score). Both the Feedback board and the Foreman
 * console render this, so the mapping is pinned here.
 */

describe("describeIntakeDecision — surfacing intake outcomes", () => {
  it("maps a guardrail HOLD to `held` with its score, categories, and reason", () => {
    const d = describeIntakeDecision({
      triage: {
        guardrail: {
          decision: "hold",
          categories: ["high-risk-zone"],
          score: 0.6,
          reason: "Held for human review: high-risk-zone — auth",
        },
      },
      deliveredAt: null,
    });
    expect(d).toEqual({
      state: "held",
      label: "Held for review",
      reason: "Held for human review: high-risk-zone — auth",
      score: 0.6,
      categories: ["high-risk-zone"],
    });
  });

  it("maps a guardrail REJECT (content-safety) to `rejected`", () => {
    const d = describeIntakeDecision({
      triage: { guardrail: { decision: "reject", categories: ["content-safety"], score: 0.9, reason: "Rejected: content-safety" } },
    });
    expect(d?.state).toBe("rejected");
    expect(d?.label).toBe("Rejected");
    expect(d?.score).toBe(0.9);
  });

  it("maps a role-gate park to `gated`", () => {
    const d = describeIntakeDecision({
      triage: { roleGate: { decision: "human-triage", role: "GUEST", reason: "Submitter role GUEST is not cleared to auto-trigger a build." } },
    });
    expect(d?.state).toBe("gated");
    expect(d?.score).toBeNull();
    expect(d?.reason).toContain("GUEST");
  });

  it("maps a rate-limit throttle to `throttled` with a submitter-facing message", () => {
    const d = describeIntakeDecision({ triage: { throttle: { reason: "duplicate-flood" } } });
    expect(d?.state).toBe("throttled");
    expect(d?.label).toBe("Queued");
    expect(d?.reason).toMatch(/duplicate/i);
  });

  it("maps a delivered item (full triage) to `accepted` with its classification", () => {
    const d = describeIntakeDecision({
      triage: { classification: "BUG", severity: "high", source: "ai", effort: "M", rationale: "x", acceptanceCriteria: [] },
      deliveredAt: "2026-07-15T00:00:00.000Z",
    });
    expect(d?.state).toBe("accepted");
    expect(d?.reason).toContain("BUG");
    expect(d?.reason).toContain("high");
  });

  it("treats a bare deliveredAt (no classification) as accepted", () => {
    const d = describeIntakeDecision({ triage: null, deliveredAt: new Date("2026-07-15") });
    expect(d?.state).toBe("accepted");
  });

  it("returns null for a fresh OPEN item with no recorded outcome", () => {
    expect(describeIntakeDecision({ triage: null, deliveredAt: null })).toBeNull();
    expect(describeIntakeDecision({ triage: {}, deliveredAt: null })).toBeNull();
    expect(describeIntakeDecision({ triage: "garbage" })).toBeNull();
  });

  it("guardrail takes precedence over a stray throttle marker", () => {
    const d = describeIntakeDecision({
      triage: {
        guardrail: { decision: "hold", categories: ["pii-secret"], score: 0.9, reason: "secret" },
        throttle: { reason: "per-org-cap" },
      },
    });
    expect(d?.state).toBe("held");
  });
});
