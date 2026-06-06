// src/lib/ai/egress/__tests__/golden-egress.test.ts
//
// End-to-end golden-egress suite: drives `runAgentLoop` with the REAL gate
// (`projectForModel`) + the REAL structural projection (`projectResult`) but
// mocked boundaries (provider, DB, tool-executor) and asserts on what actually
// reaches the model via `callModel` on the 2nd turn.
//
// Phase-1 verified the deterministic MAC ceiling (expose / withhold). Phase-2
// upgrades the WITHHOLD branch from a blanket `{withheld:true}` to a STRUCTURAL
// projection: the model can address entities by `id` (+ allowlisted enums/dates)
// but never sees free-text/content/CUI. These cases pin that behavior on the
// REAL executor wrapper shapes (`{count, items:[...]}`, `{count, results:[...]}`).

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
 * The `content` field on each block is `JSON.stringify(modelView)`.
 */
function extractToolResultContent(callModelMessages: unknown[]): string {
  const userMsgs = (callModelMessages as Array<{ role: string; content: unknown }>)
    .filter((m) => m.role === "user");
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

/** Build the two model turns: one tool_use, then end_turn. */
function turns(toolName: string) {
  const toolUse = {
    text: "",
    toolUses: [{ id: "tu-g1", name: toolName, input: {} }],
    stopReason: "tool_use",
  };
  const end = { text: "Done.", toolUses: [], stopReason: "end_turn" };
  return { toolUse, end };
}

// A real `listWorkItems` wrapper carrying a CUI title.
const WORK_ITEM_RESULT = {
  count: 1,
  items: [{ id: "w1", title: "CUI//SP", status: "DONE", columnKey: "done" }],
};
// A real `semanticSearch` wrapper carrying a CUI snippet.
const SEARCH_RESULT = {
  query: "kill chain",
  count: 1,
  results: [{ id: "n1", type: "note", similarity: 0.8, title: "CUI title", snippet: "CUI body" }],
};
// A real `getFinanceSummary`-style wrapper (no entity mapping ⇒ full withhold).
const FINANCE_RESULT = { total: 5000, currency: "USD" };

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("golden-egress: MAC ceiling + structural projection end-to-end via runAgentLoop", () => {
  beforeEach(() => {
    callModel.mockReset();
    executeTool.mockReset();
    effectiveCeiling.mockReset();
    logEgressDecision.mockReset();
  });

  // -------------------------------------------------------------------------
  // Case 1: gov + CUI ceiling → structural projection (id/status, NOT the title)
  // -------------------------------------------------------------------------
  it("case 1 — gov + list_work_items (CUI) → model sees id+status, NOT the CUI title", async () => {
    const { toolUse, end } = turns("list_work_items");
    callModel.mockResolvedValueOnce(toolUse).mockResolvedValueOnce(end);
    effectiveCeiling.mockResolvedValue("CUI");
    executeTool.mockResolvedValue(WORK_ITEM_RESULT);

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("gov"));

    expect(callModel).toHaveBeenCalledTimes(2);
    const content = extractToolResultContent(callModel.mock.calls[1][0].messages as unknown[]);

    // Structural identifiers + count survive…
    expect(content).toContain("w1");
    expect(content).toContain("DONE");
    expect(content).toContain("count");
    // …but the CUI title + free-text columnKey never reach the model.
    expect(content).not.toContain("CUI//SP");
    expect(content).not.toContain("\"done\""); // columnKey value dropped (status "DONE" stays)
  });

  // -------------------------------------------------------------------------
  // Case 2: commercial + CUI ceiling → SAME structural-only (mandatory ≥FOUO ceiling)
  // -------------------------------------------------------------------------
  it("case 2 — commercial + list_work_items (CUI) → structural-only too (mandatory ceiling)", async () => {
    const { toolUse, end } = turns("list_work_items");
    callModel.mockResolvedValueOnce(toolUse).mockResolvedValueOnce(end);
    effectiveCeiling.mockResolvedValue("CUI");
    executeTool.mockResolvedValue(WORK_ITEM_RESULT);

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("commercial"));

    const content = extractToolResultContent(callModel.mock.calls[1][0].messages as unknown[]);

    expect(content).toContain("w1");
    expect(content).toContain("DONE");
    // CUI ceiling withholds the title even for a commercial tenant.
    expect(content).not.toContain("CUI//SP");
  });

  // -------------------------------------------------------------------------
  // Case 3: commercial + UNCLASSIFIED → FULL exposure (title present)
  // -------------------------------------------------------------------------
  it("case 3 — commercial + list_work_items (UNCLASSIFIED) → FULL value incl. title", async () => {
    const { toolUse, end } = turns("list_work_items");
    callModel.mockResolvedValueOnce(toolUse).mockResolvedValueOnce(end);
    effectiveCeiling.mockResolvedValue("UNCLASSIFIED");
    executeTool.mockResolvedValue(WORK_ITEM_RESULT);

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("commercial"));

    const content = extractToolResultContent(callModel.mock.calls[1][0].messages as unknown[]);

    // Below the FOUO ceiling, a commercial tenant sees the full value, title included.
    expect(content).toContain("CUI//SP");
    expect(content).toContain("w1");
  });

  // -------------------------------------------------------------------------
  // Case 4: gov + UNCLASSIFIED → STILL structural-only (gov default-deny)
  // -------------------------------------------------------------------------
  it("case 4 — gov + list_work_items (UNCLASSIFIED) → structural-only (gov default-deny)", async () => {
    const { toolUse, end } = turns("list_work_items");
    callModel.mockResolvedValueOnce(toolUse).mockResolvedValueOnce(end);
    effectiveCeiling.mockResolvedValue("UNCLASSIFIED");
    executeTool.mockResolvedValue(WORK_ITEM_RESULT);

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("gov"));

    const content = extractToolResultContent(callModel.mock.calls[1][0].messages as unknown[]);

    // Gov default-denies the full value even at UNCLASSIFIED → structural only.
    expect(content).toContain("w1");
    expect(content).not.toContain("CUI//SP");
  });

  // -------------------------------------------------------------------------
  // Case 5: gov + semantic_search → id/type/similarity, NEVER the snippet
  // -------------------------------------------------------------------------
  it("case 5 — gov + semantic_search → model sees id/type/similarity, NOT the CUI snippet", async () => {
    const { toolUse, end } = turns("semantic_search");
    callModel.mockResolvedValueOnce(toolUse).mockResolvedValueOnce(end);
    effectiveCeiling.mockResolvedValue("CUI");
    executeTool.mockResolvedValue(SEARCH_RESULT);

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("gov"));

    const content = extractToolResultContent(callModel.mock.calls[1][0].messages as unknown[]);

    expect(content).toContain("n1");
    expect(content).toContain("note");
    expect(content).toContain("0.8");
    // The snippet/title/query free-text must never reach the model.
    expect(content).not.toContain("CUI body");
    expect(content).not.toContain("CUI title");
    expect(content).not.toContain("kill chain"); // echoed `query` wrapper field dropped
  });

  // -------------------------------------------------------------------------
  // Case 6: gov + get_finance_summary → FULL withhold (no allowlist for finance)
  // -------------------------------------------------------------------------
  it("case 6 — gov + get_finance_summary → FULL withhold, no structural/numeric leak", async () => {
    const { toolUse, end } = turns("get_finance_summary");
    callModel.mockResolvedValueOnce(toolUse).mockResolvedValueOnce(end);
    effectiveCeiling.mockResolvedValue("CUI");
    executeTool.mockResolvedValue(FINANCE_RESULT);

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("gov"));

    const content = extractToolResultContent(callModel.mock.calls[1][0].messages as unknown[]);

    // No entity mapping ⇒ full withhold; even the (non-CUI) total must not leak.
    expect(content).toContain("withheld");
    expect(content).not.toContain("5000");
    expect(content).not.toContain("USD");
  });

  // -------------------------------------------------------------------------
  // Case 7: error payload with a CUI marker on a CUI ceiling → not echoed
  // -------------------------------------------------------------------------
  it("case 7 — error payload with CUI marker (CUI ceiling) is NOT echoed to the model", async () => {
    const { toolUse, end } = turns("list_work_items");
    callModel.mockResolvedValueOnce(toolUse).mockResolvedValueOnce(end);
    effectiveCeiling.mockResolvedValue("CUI");
    // An error object whose message carries a CUI token.
    executeTool.mockResolvedValue({ error: "failed near CUI//token-XYZ" });

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("commercial"));

    const content = extractToolResultContent(callModel.mock.calls[1][0].messages as unknown[]);

    // ceiling = CUI (≥ FOUO) → withheld; projectResult drops the free-text `error`
    // string (no allowlisted scalar / array survives) so the token never reaches
    // the model.
    expect(content).not.toContain("CUI//token-XYZ");
  });
});
