// src/lib/ai/egress/__tests__/observe-only.test.ts
//
// Pins that the SI-4 instrumentation added to the chokepoint is OBSERVE-ONLY and that the
// fail-closed semantics are PRESERVED EXACTLY:
//   1. A classifier THROW (model down) still REJECTS runModelTurn — the model is never
//      called → unmarked CUI never egresses (fail-closed). The classifier-down metric +
//      the egress-error metric both fire (that's the whole point — make it visible), but
//      the control-flow outcome is identical to pre-instrumentation behavior.
//   2. When the classifier returns true (likely CUI), the body is still WITHHELD before
//      reaching the model — instrumentation did not loosen the gate.
//   3. The happy path still calls the model exactly once with the gated content.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { callModel, effectiveCeiling, logEgressDecision, classifyLikelyCui, recordClassifierError, recordEgressError, recordClassifier, recordEgressDecision } =
  vi.hoisted(() => ({
    callModel: vi.fn(),
    effectiveCeiling: vi.fn(),
    logEgressDecision: vi.fn(),
    classifyLikelyCui: vi.fn().mockResolvedValue(false) as ReturnType<typeof vi.fn<() => Promise<boolean>>>,
    recordClassifierError: vi.fn(),
    recordEgressError: vi.fn(),
    recordClassifier: vi.fn(),
    recordEgressDecision: vi.fn(),
  }));

vi.mock("@/lib/ai/egress/provider", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callModel,
}));
vi.mock("@/lib/classification/effective", () => ({ effectiveCeiling }));
vi.mock("@/lib/ai/egress/audit", () => ({ logEgressDecision }));
vi.mock("@/lib/classification/classifier", () => ({ classifyLikelyCui }));
// Spy on the metrics seam so we can assert the signals fire WITHOUT asserting on OTel internals.
vi.mock("@/lib/observability/metrics", () => ({
  recordClassifierError,
  recordEgressError,
  recordClassifier,
  recordEgressDecision,
}));

import { runModelTurn } from "@/lib/ai/egress";
import type { EgressContext } from "@/lib/ai/egress/types";

function ctx(tenantClass: "gov" | "commercial"): EgressContext {
  return { orgId: "org-x", conversationId: "conv-x", turn: 1, tenantClass, mode: "enforced" };
}

function turnInput(tenantClass: "gov" | "commercial", userText: string) {
  return {
    ctx: ctx(tenantClass),
    system: "you are cosmos",
    messages: [{ role: "user" as const, content: userText }],
    tools: [],
    model: "test-model",
  };
}

describe("egress instrumentation is observe-only (fail-closed preserved)", () => {
  beforeEach(() => {
    callModel.mockReset();
    effectiveCeiling.mockReset().mockResolvedValue("UNCLASSIFIED");
    logEgressDecision.mockReset();
    classifyLikelyCui.mockReset().mockResolvedValue(false);
    recordClassifierError.mockReset();
    recordEgressError.mockReset();
    recordClassifier.mockReset();
    recordEgressDecision.mockReset();
    callModel.mockResolvedValue({ text: "ok", toolUses: [], stopReason: "end_turn" });
  });

  it("classifier throw → runModelTurn REJECTS (model never called) and emits the error signals", async () => {
    classifyLikelyCui.mockRejectedValueOnce(new Error("embeddings model unavailable"));

    await expect(runModelTurn(turnInput("gov", "some unmarked prompt"))).rejects.toThrow(
      /embeddings model unavailable/,
    );

    // FAIL-CLOSED preserved: the model was NOT called because the classifier was down.
    expect(callModel).not.toHaveBeenCalled();
    // The classifier-down signal + the chokepoint-error signal both fired (observability).
    expect(recordClassifierError).toHaveBeenCalledTimes(1);
    expect(recordEgressError).toHaveBeenCalledWith("classifier");
  });

  it("classifier=true (likely CUI) → body WITHHELD before the model (gate not loosened)", async () => {
    classifyLikelyCui.mockResolvedValueOnce(true);

    // Plain text with NO controlled marking token, so the deterministic marking gate
    // EXPOSES it — leaving the classifier tripwire as the deciding factor (allow→deny).
    await runModelTurn(turnInput("gov", "the quarterly logistics planning summary"));

    expect(callModel).toHaveBeenCalledTimes(1);
    const sent = callModel.mock.calls[0][0].messages[0].content;
    expect(sent).toBe("[withheld: classifier]");
    expect(recordClassifier).toHaveBeenCalledWith({ result: "deny", latencyMs: expect.any(Number) });
  });

  it("happy path (non-CUI gov) → model called once with the original content + allow recorded", async () => {
    await runModelTurn(turnInput("gov", "benign prompt"));

    expect(callModel).toHaveBeenCalledTimes(1);
    expect(callModel.mock.calls[0][0].messages[0].content).toBe("benign prompt");
    expect(recordClassifier).toHaveBeenCalledWith({ result: "allow", latencyMs: expect.any(Number) });
    expect(recordEgressError).not.toHaveBeenCalled();
  });

  it("commercial tenant → classifier is NOT invoked (gov-only tripwire unchanged)", async () => {
    await runModelTurn(turnInput("commercial", "anything"));

    expect(classifyLikelyCui).not.toHaveBeenCalled();
    expect(callModel).toHaveBeenCalledTimes(1);
  });
});
