// src/lib/ai/egress/__tests__/golden-egress.test.ts
//
// End-to-end golden-egress suite: drives `runAgentLoop` with the REAL gate
// (`projectForModel`) but mocked boundaries (provider, DB, tool-executor) and
// asserts on what actually reaches the model via `callModel` on the 2nd turn.
//
// This is the Phase-1 invariant harness — it verifies the deterministic MAC
// ceiling at the loop level, not just at the unit level.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted spies — must be created before any vi.mock() factory executes.
// ---------------------------------------------------------------------------
const { callModel, executeTool, effectiveCeiling, logEgressDecision } = vi.hoisted(() => ({
  callModel: vi.fn(),
  executeTool: vi.fn(),
  effectiveCeiling: vi.fn(),
  logEgressDecision: vi.fn(),
}));

// Mock the provider — keeps the real runModelTurn + projectForModel in play;
// only the network boundary is replaced.
vi.mock("@/lib/ai/egress/provider", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callModel,
}));

// Mock the tool-executor — tools return whatever each test provides.
vi.mock("@/lib/ai/tool-executor", () => ({ executeTool }));

// Mock effectiveCeiling — each test sets the ceiling it needs; avoids the DB.
vi.mock("@/lib/classification/effective", () => ({ effectiveCeiling }));

// Mock the audit sink — avoids prisma during tests.
vi.mock("@/lib/ai/egress/audit", () => ({ logEgressDecision }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal options for runAgentLoop with one tool available. */
function loopOpts(
  tenantClass: "commercial" | "gov",
  extra: Partial<Parameters<typeof import("@/lib/ai/agent-loop").runAgentLoop>[0]> = {},
) {
  return {
    orgId: "org-golden",
    userId: "u-golden",
    tenantClass,
    conversationId: "conv-golden",
    systemPrompt: "you are cosmos",
    initialPrompt: "run the tool",
    ...extra,
  };
}

/**
 * Extract the stringified content of the tool_result block(s) from the
 * messages array passed to `callModel` on the second turn.
 *
 * The loop appends: { role: "user", content: [{ type: "tool_result", tool_use_id, content: string }] }
 * The `content` field on each block is `JSON.stringify(projected.modelValue)`.
 */
function extractToolResultContent(callModelMessages: unknown[]): string {
  // Find the last user message — it is the tool-result message appended by the loop.
  const userMsgs = (callModelMessages as Array<{ role: string; content: unknown }>)
    .filter((m) => m.role === "user");
  // The tool_result message is after the initial user message (which is a plain string).
  const toolResultMsg = userMsgs.find(
    (m) => Array.isArray(m.content) &&
      (m.content as Array<{ type: string }>).some((b) => b.type === "tool_result"),
  );
  if (!toolResultMsg) return "";
  const blocks = toolResultMsg.content as Array<{ type: string; content?: string }>;
  return blocks
    .filter((b) => b.type === "tool_result")
    .map((b) => b.content ?? "")
    .join(" ");
}

// ---------------------------------------------------------------------------
// Setup: a single tool_use on turn 1, then end_turn on turn 2.
// ---------------------------------------------------------------------------
const TOOL_USE_TURN = {
  text: "",
  toolUses: [{ id: "tu-g1", name: "list_work_items", input: {} }],
  stopReason: "tool_use",
};
const END_TURN = { text: "Done.", toolUses: [], stopReason: "end_turn" };

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("golden-egress: MAC ceiling end-to-end via runAgentLoop", () => {
  beforeEach(() => {
    callModel.mockReset();
    executeTool.mockReset();
    effectiveCeiling.mockReset();
    logEgressDecision.mockReset();

    // Default callModel: tool_use on first call, end_turn on second.
    callModel.mockResolvedValueOnce(TOOL_USE_TURN).mockResolvedValueOnce(END_TURN);
  });

  // -------------------------------------------------------------------------
  // Case 1: CUI withheld for a COMMERCIAL org
  // -------------------------------------------------------------------------
  it("case 1 — CUI tool result is WITHHELD for a commercial org (cross-domain invariant)", async () => {
    effectiveCeiling.mockResolvedValue("CUI");
    executeTool.mockResolvedValue("CUI//SP secret");

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("commercial"));

    expect(callModel).toHaveBeenCalledTimes(2);
    const secondMessages = callModel.mock.calls[1][0].messages as unknown[];
    const toolResultContent = extractToolResultContent(secondMessages);

    // The raw CUI string must NOT reach the model.
    expect(toolResultContent).not.toContain("CUI//SP secret");
    // A withheld marker must be present instead.
    expect(toolResultContent).toContain("withheld");
  });

  // -------------------------------------------------------------------------
  // Case 2: Unclassified EXPOSED for commercial
  // -------------------------------------------------------------------------
  it("case 2 — UNCLASSIFIED tool result is EXPOSED for a commercial org", async () => {
    effectiveCeiling.mockResolvedValue("UNCLASSIFIED");
    executeTool.mockResolvedValue("3 open tasks");

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("commercial"));

    expect(callModel).toHaveBeenCalledTimes(2);
    const secondMessages = callModel.mock.calls[1][0].messages as unknown[];
    const toolResultContent = extractToolResultContent(secondMessages);

    // Unclassified data must be visible to the model for a commercial org.
    expect(toolResultContent).toContain("3 open tasks");
  });

  // -------------------------------------------------------------------------
  // Case 3: Unclassified WITHHELD for gov (default-deny)
  // -------------------------------------------------------------------------
  it("case 3 — UNCLASSIFIED tool result is WITHHELD for a gov org (default-deny)", async () => {
    effectiveCeiling.mockResolvedValue("UNCLASSIFIED");
    executeTool.mockResolvedValue("3 open tasks");

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("gov"));

    expect(callModel).toHaveBeenCalledTimes(2);
    const secondMessages = callModel.mock.calls[1][0].messages as unknown[];
    const toolResultContent = extractToolResultContent(secondMessages);

    // Gov tenant default-denies ALL data regardless of classification.
    expect(toolResultContent).not.toContain("3 open tasks");
    expect(toolResultContent).toContain("withheld");
  });

  // -------------------------------------------------------------------------
  // Case 4: Fail-closed at ≥FOUO regardless of tenant
  // -------------------------------------------------------------------------
  it("case 4 — FOUO ceiling is WITHHELD for commercial (fail-closed at ≥FOUO)", async () => {
    effectiveCeiling.mockResolvedValue("FOUO");
    executeTool.mockResolvedValue("sensitive operational data");

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("commercial"));

    expect(callModel).toHaveBeenCalledTimes(2);
    const secondMessages = callModel.mock.calls[1][0].messages as unknown[];
    const toolResultContent = extractToolResultContent(secondMessages);

    // FOUO is >= the FOUO threshold: must be withheld for commercial too.
    expect(toolResultContent).not.toContain("sensitive operational data");
    expect(toolResultContent).toContain("withheld");
  });

  // -------------------------------------------------------------------------
  // Case 5: Error payload carrying a CUI marker is not echoed
  // -------------------------------------------------------------------------
  it("case 5 — error payload with CUI marker is NOT echoed to the model", async () => {
    effectiveCeiling.mockResolvedValue("CUI");
    // The tool-executor returns an error object containing a CUI token.
    executeTool.mockResolvedValue({ error: "failed near CUI//token-XYZ" });

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("commercial"));

    expect(callModel).toHaveBeenCalledTimes(2);
    const secondMessages = callModel.mock.calls[1][0].messages as unknown[];
    const toolResultContent = extractToolResultContent(secondMessages);

    // The CUI token in the error must NOT reach the model — the entire result
    // is withheld because ceiling = CUI (≥ FOUO threshold).
    expect(toolResultContent).not.toContain("CUI//token-XYZ");
    expect(toolResultContent).toContain("withheld");
  });
});
