import { describe, expect, it, vi } from "vitest";
import type { Candidate } from "@/lib/dedup/dedup";
import type { ModelTurnResult } from "@/lib/ai/egress";
import {
  detectLowQuality,
  findFeedbackDuplicate,
  judgeFeedbackScope,
  lowQualityResult,
  duplicateResult,
  scopeResult,
  type IntakeJudgeDeps,
  type IntakeJudgeInput,
  type ScopeVerdict,
} from "./intake-guardrails";

/**
 * COSMOS-113 (Phase 2) — intake duplicate + necessity/scope classification that
 * runs AFTER the Phase-1 security gate. The deterministic low-quality floor is
 * pure; the dedup + scope LLM layers are fail-safe (unique + actionable on any
 * model failure) so a genuine request is never silently dropped.
 */

const FOREMAN_CREDS = { accessToken: "tok", refreshToken: null, expiresAt: 0 };

const input = (title: string, description = ""): IntakeJudgeInput => ({
  orgId: "org1",
  tenantClass: "commercial",
  feedbackId: "fb1",
  title,
  description,
});

function turn(name: string, toolInput: Record<string, unknown>): ModelTurnResult {
  return { text: "", toolUses: [{ id: "t1", name, input: toolInput }], stopReason: "tool_use" };
}

function deps(run: () => Promise<ModelTurnResult>, over: Partial<IntakeJudgeDeps> = {}): IntakeJudgeDeps {
  return {
    getForemanCredsImpl: vi.fn(async () => FOREMAN_CREDS),
    runModelTurnImpl: vi.fn(run),
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Deterministic low-quality / nonsense / spam floor (reject cases)
// ─────────────────────────────────────────────────────────────────────────────

describe("detectLowQuality — deterministic reject floor", () => {
  it("rejects empty / whitespace-only feedback", () => {
    expect(detectLowQuality({ title: "", description: "" })).not.toBeNull();
    expect(detectLowQuality({ title: "   ", description: "\n\t " })).not.toBeNull();
    expect(detectLowQuality({ title: "", description: null })).not.toBeNull();
  });

  it("rejects symbol/punctuation-only content", () => {
    expect(detectLowQuality({ title: "!!!???", description: "" })).not.toBeNull();
    expect(detectLowQuality({ title: ".", description: "" })).not.toBeNull();
  });

  it("rejects a single repeated character", () => {
    expect(detectLowQuality({ title: "aaaaaaa", description: "" })).not.toBeNull();
    expect(detectLowQuality({ title: "......", description: "" })).not.toBeNull();
  });

  it("rejects keyboard-mash gibberish", () => {
    expect(detectLowQuality({ title: "asdfghjkl", description: "" })).not.toBeNull();
    expect(detectLowQuality({ title: "please fix", description: "qwertyuiop" })).not.toBeNull();
  });

  it("rejects promotional spam", () => {
    expect(detectLowQuality({ title: "Buy now cheap forex", description: "click here" })).not.toBeNull();
    expect(detectLowQuality({ title: "make money fast", description: "" })).not.toBeNull();
  });

  it("carries the low-quality category into the reject result", () => {
    const finding = detectLowQuality({ title: "", description: "" })!;
    const result = lowQualityResult(finding);
    expect(result.decision).toBe("reject");
    expect(result.categories).toContain("low-quality");
    expect(result.reason).toMatch(/low-quality/i);
  });

  it("does NOT reject a blunt but genuine bug/feature report", () => {
    expect(detectLowQuality({ title: "Crash when I click save", description: "" })).toBeNull();
    expect(detectLowQuality({ title: "Add dark mode", description: "the board is too bright at night" })).toBeNull();
    expect(detectLowQuality({ title: "Export to CSV", description: "please" })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Necessity / scope / actionability classification
// ─────────────────────────────────────────────────────────────────────────────

describe("judgeFeedbackScope + scopeResult — scope classes", () => {
  it("actionable → no hold/reject (proceeds to triage)", async () => {
    const verdict = await judgeFeedbackScope(
      input("Add a CSV export button to the board"),
      deps(async () => turn("classify_scope", { class: "actionable", confidence: "high", reason: "clear" })),
    );
    expect(verdict?.class).toBe("actionable");
    expect(scopeResult(verdict!)).toBeNull();
  });

  it("needs-clarification → hold with a needs-decision reason", async () => {
    const verdict = await judgeFeedbackScope(
      input("Show the important metrics on the dashboard"),
      deps(async () => turn("classify_scope", { class: "needs-clarification", confidence: "high", reason: "which metrics?" })),
    );
    const result = scopeResult(verdict!)!;
    expect(result.decision).toBe("hold");
    expect(result.categories).toContain("needs-decision");
    expect(result.reason).toMatch(/clarification|decision/i);
  });

  it("out-of-scope → hold with an out-of-scope reason", async () => {
    const verdict = await judgeFeedbackScope(
      input("Change our company's refund policy to 60 days"),
      deps(async () => turn("classify_scope", { class: "out-of-scope", confidence: "high", reason: "business policy" })),
    );
    const result = scopeResult(verdict!)!;
    expect(result.decision).toBe("hold");
    expect(result.categories).toContain("out-of-scope");
  });

  it("reject → declines nonsense the deterministic floor missed", async () => {
    const verdict = await judgeFeedbackScope(
      input("test test ignore this"),
      deps(async () => turn("classify_scope", { class: "reject", confidence: "high", reason: "test input" })),
    );
    const result = scopeResult(verdict!)!;
    expect(result.decision).toBe("reject");
    expect(result.categories).toContain("low-quality");
  });

  it("bounds false positives — a LOW-confidence non-actionable verdict flows as actionable", async () => {
    const verdict = await judgeFeedbackScope(
      input("some ambiguous ask"),
      deps(async () => turn("classify_scope", { class: "out-of-scope", confidence: "low", reason: "maybe" })),
    );
    expect(verdict?.class).toBe("actionable");
    expect(scopeResult(verdict!)).toBeNull();
  });

  it("fail-safe — returns null (→ actionable) when the model throws", async () => {
    const verdict = await judgeFeedbackScope(
      input("add dark mode"),
      deps(async () => {
        throw new Error("model down");
      }),
    );
    expect(verdict).toBeNull();
  });

  it("fail-safe — returns null when the org has no Foreman subscription (never reaches the model)", async () => {
    const run = vi.fn();
    const verdict = await judgeFeedbackScope(
      input("add dark mode"),
      { getForemanCredsImpl: vi.fn(async () => null), runModelTurnImpl: run },
    );
    expect(verdict).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("fail-safe — returns null on malformed tool output", async () => {
    const verdict = await judgeFeedbackScope(
      input("add dark mode"),
      deps(async () => ({ text: "hi", toolUses: [], stopReason: "end_turn" })),
    );
    expect(verdict).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Duplicate / redundancy detection
// ─────────────────────────────────────────────────────────────────────────────

describe("findFeedbackDuplicate — dup match via prefilter + judge", () => {
  const candidates: Candidate[] = [
    { ref: "F:existing-1", title: "Add a dark mode toggle in settings" },
    { ref: "TEST-42", title: "Bulk import users from CSV" },
  ];

  it("links a near-duplicate to the matched existing item", async () => {
    const match = await findFeedbackDuplicate(
      input("Please add dark mode to the settings page"),
      candidates,
      deps(async () => turn("dedup_judgment", { duplicate: true, ref: "F:existing-1", reason: "same dark mode ask" })),
    );
    expect(match).not.toBeNull();
    expect(match!.dupOf).toBe("F:existing-1");

    const result = duplicateResult(match!.dupOf, match!.reason);
    expect(result.decision).toBe("hold");
    expect(result.categories).toContain("duplicate");
    expect(result.duplicateOf?.ref).toBe("F:existing-1");
  });

  it("returns null when the judge says unique (shortlist matched, judge disagrees)", async () => {
    // Overlaps the dark-mode candidate on tokens, so the prefilter shortlists it
    // and the judge is actually consulted — then rules it a distinct request.
    const run = vi.fn(async () => turn("dedup_judgment", { duplicate: false, ref: "", reason: "different feature" }));
    const match = await findFeedbackDuplicate(input("Add a dark mode keyboard shortcut"), candidates, deps(run));
    expect(match).toBeNull();
    expect(run).toHaveBeenCalled();
  });

  it("never trusts a ref the model invented (not in the shortlist)", async () => {
    const match = await findFeedbackDuplicate(
      input("Please add dark mode to the settings page"),
      candidates,
      deps(async () => turn("dedup_judgment", { duplicate: true, ref: "F:hallucinated", reason: "nope" })),
    );
    expect(match).toBeNull();
  });

  it("skips the judge entirely when the token prefilter finds nothing plausible", async () => {
    const run = vi.fn(async () => turn("dedup_judgment", { duplicate: true, ref: "F:existing-1", reason: "x" }));
    const match = await findFeedbackDuplicate(
      input("Completely unrelated request about invoice pagination speed"),
      candidates,
      deps(run, {}),
    );
    expect(match).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("returns null with no candidates", async () => {
    const run = vi.fn();
    const match = await findFeedbackDuplicate(input("anything"), [], { runModelTurnImpl: run });
    expect(match).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("fail-safe — treats a model outage as unique (no false duplicate)", async () => {
    const match = await findFeedbackDuplicate(
      input("Please add dark mode to the settings page"),
      candidates,
      deps(async () => {
        throw new Error("model down");
      }),
    );
    expect(match).toBeNull();
  });

  it("fail-safe — no Foreman subscription ⇒ unique (never reaches the model)", async () => {
    const run = vi.fn();
    const match = await findFeedbackDuplicate(
      input("Please add dark mode to the settings page"),
      candidates,
      { getForemanCredsImpl: vi.fn(async () => null), runModelTurnImpl: run },
    );
    expect(match).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Pure mappers
// ─────────────────────────────────────────────────────────────────────────────

describe("intake decision mappers (pure)", () => {
  it("duplicateResult carries the link for the caller to merge into", () => {
    const r = duplicateResult("F:abc", "same request");
    expect(r.decision).toBe("hold");
    expect(r.duplicateOf).toEqual({ ref: "F:abc", reason: "same request" });
  });

  it("scopeResult(actionable) is null", () => {
    const v: ScopeVerdict = { class: "actionable", reason: "clear" };
    expect(scopeResult(v)).toBeNull();
  });
});
