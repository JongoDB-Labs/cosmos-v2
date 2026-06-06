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
const { callModel, executeTool, effectiveCeiling, logEgressDecision, classifyLikelyCui } = vi.hoisted(() => ({
  callModel: vi.fn(),
  executeTool: vi.fn(),
  effectiveCeiling: vi.fn(),
  logEgressDecision: vi.fn(),
  // Classifier mock: default non-CUI; individual tests override for defense-topic prompts.
  classifyLikelyCui: vi.fn().mockResolvedValue(false) as ReturnType<typeof vi.fn<() => Promise<boolean>>>,
}));

// Mock the provider — keeps the real runModelTurn + projectForModel in play;
// only the network boundary is replaced.
vi.mock("@/lib/ai/egress/provider", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callModel,
}));

// Mock the tool-executor — tools return whatever each test provides.
vi.mock("@/lib/ai/tool-executor", () => ({ executeTool }));

// Mock effectiveCeiling — each test sets the ceiling it needs; avoids the DB. Keep the
// real pure helpers (maxByRank/rankOf) so the loop's C1 ceiling fold runs for real.
vi.mock("@/lib/classification/effective", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  effectiveCeiling,
}));

// Mock the audit sink — avoids prisma during tests.
vi.mock("@/lib/ai/egress/audit", () => ({ logEgressDecision }));

// Mock the classifier — avoids the ONNX runtime (jsdom-incompatible Float32Array).
// The classifier has its own dedicated node-env test for behavioral correctness.
vi.mock("@/lib/classification/classifier", () => ({ classifyLikelyCui }));

// Mock the opaque-handle store — avoids prisma/vault during the golden suite while
// keeping the REAL augmentWithHandles matching logic (projection.ts) in play.
// mintHandle returns a deterministic token (a non-CUI reference); resolveHandlesDeep
// is a passthrough (no handles were really minted). The golden cases assert the
// structural floor + that the CUI VALUE never reaches the model — a token is not
// CUI, so those assertions are unaffected. Handle MINT/RESOLVE behavior has its own
// dedicated suites (handles.test.ts, augment.test.ts, handles-loop.redteam.test.ts).
vi.mock("@/lib/ai/egress/handles", () => ({
  mintHandle: vi.fn(async () => "h:GOLDENTOKEN00000000000000"),
  resolveHandle: vi.fn(async () => null),
  resolveHandlesDeep: vi.fn(async (input: unknown) => ({ resolved: input, count: 0 })),
  isHandle: (s: unknown) => typeof s === "string" && /^h:[A-Za-z0-9_-]{24}$/.test(s),
}));

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
    // Reset call count + restore default (benign); tests that need a CUI hit override this.
    classifyLikelyCui.mockReset();
    classifyLikelyCui.mockResolvedValue(false);
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
  // Case 3: commercial + UNCLASSIFIED → structural exposure (id present; marked
  // title withheld by marking-DLP tripwire even at UNCLASSIFIED)
  // -------------------------------------------------------------------------
  it("case 3 — commercial + list_work_items (UNCLASSIFIED) → id present, marked title withheld by tripwire", async () => {
    const { toolUse, end } = turns("list_work_items");
    callModel.mockResolvedValueOnce(toolUse).mockResolvedValueOnce(end);
    effectiveCeiling.mockResolvedValue("UNCLASSIFIED");
    executeTool.mockResolvedValue(WORK_ITEM_RESULT);

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("commercial"));

    const content = extractToolResultContent(callModel.mock.calls[1][0].messages as unknown[]);

    // The tool result contains title "CUI//SP" — the marking-DLP tripwire withholds
    // the entire value (allow→deny) even though ceiling=UNCLASSIFIED + commercial
    // would ordinarily expose it. The structural projection then applies, so the
    // model still receives the id (w1) and status (DONE) but never the marked title.
    expect(content).toContain("w1");
    expect(content).toContain("DONE");
    // Marking tripwire fires: CUI//SP in the tool result → withheld entirely, then
    // structural projection → id/status survive, free-text title never reaches model.
    expect(content).not.toContain("CUI//SP");
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

  // -------------------------------------------------------------------------
  // Phase-2c: marking-DLP on prompt / history / channel context
  // -------------------------------------------------------------------------

  // Case 8: marker in the user prompt → withheld before reaching the model
  it("case 8 — marker in the user prompt is withheld (prompt never reaches callModel)", async () => {
    const end = { text: "Done.", toolUses: [], stopReason: "end_turn" };
    callModel.mockResolvedValueOnce(end);
    effectiveCeiling.mockResolvedValue("UNCLASSIFIED");

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("commercial", { initialPrompt: "summarize CUI//SP-PROPIN notes" }));

    expect(callModel).toHaveBeenCalledTimes(1);
    const messages = callModel.mock.calls[0][0].messages as Array<{ role: string; content: unknown }>;
    const userMsg = messages.find((m) => m.role === "user");
    // The marked prompt MUST be substituted — never reach the model verbatim.
    expect(userMsg?.content).toBe("[withheld: controlled marking]");
    expect(userMsg?.content).not.toContain("CUI//SP-PROPIN");
  });

  // Case 9: marker in rendered history (FOUO line) → withheld
  it("case 9 — marker in rendered history/channel-context blob is withheld", async () => {
    const end = { text: "Done.", toolUses: [], stopReason: "end_turn" };
    callModel.mockResolvedValueOnce(end);
    effectiveCeiling.mockResolvedValue("UNCLASSIFIED");

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("gov", { initialPrompt: "Channel history:\nFOUO — prior message\nSummarize the above." }));

    expect(callModel).toHaveBeenCalledTimes(1);
    const messages = callModel.mock.calls[0][0].messages as Array<{ role: string; content: unknown }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.content).toBe("[withheld: controlled marking]");
    expect(String(userMsg?.content)).not.toContain("FOUO");
  });

  // Case 10: clean prompt flows verbatim (no false positive)
  it("case 10 — clean prompt flows verbatim through runModelTurn (no false positive)", async () => {
    const end = { text: "Done.", toolUses: [], stopReason: "end_turn" };
    callModel.mockResolvedValueOnce(end);
    effectiveCeiling.mockResolvedValue("UNCLASSIFIED");

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("commercial", { initialPrompt: "summarize the open tasks" }));

    expect(callModel).toHaveBeenCalledTimes(1);
    const messages = callModel.mock.calls[0][0].messages as Array<{ role: string; content: unknown }>;
    const userMsg = messages.find((m) => m.role === "user");
    // Clean prompt must not be withheld.
    expect(userMsg?.content).toBe("summarize the open tasks");
  });

  // Case 11: marked tool_result (gate/loop already withholds) + marked prompt → both withheld in one run
  it("case 11 — marked prompt + marked tool_result both withheld in a single run", async () => {
    const { toolUse, end } = turns("list_work_items");
    callModel.mockResolvedValueOnce(toolUse).mockResolvedValueOnce(end);
    effectiveCeiling.mockResolvedValue("UNCLASSIFIED");
    // Tool result carries a CUI title — tool_result projection will drop it structurally
    executeTool.mockResolvedValue(WORK_ITEM_RESULT); // WORK_ITEM_RESULT has title "CUI//SP"

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("commercial", { initialPrompt: "summarize NOFORN briefing notes" }));

    expect(callModel).toHaveBeenCalledTimes(2);

    // Turn 0: the marked prompt is withheld.
    const turn0messages = callModel.mock.calls[0][0].messages as Array<{ role: string; content: unknown }>;
    const turn0user = turn0messages.find((m) => m.role === "user");
    expect(turn0user?.content).toBe("[withheld: controlled marking]");

    // Turn 1: the tool_result title "CUI//SP" never reaches the model (ceiling=UNCLASSIFIED
    // for a commercial tenant exposes the tool result, but marking tripwire withholds it on
    // the gate — and the structural projection drops the free-text title in any case).
    const turn1content = extractToolResultContent(callModel.mock.calls[1][0].messages as unknown[]);
    expect(turn1content).not.toContain("CUI//SP");
    expect(turn1content).toContain("w1"); // id survives structural projection
  });

  // -------------------------------------------------------------------------
  // Phase-3 classifier tripwire (gov-only, allow→deny, detector-only)
  // -------------------------------------------------------------------------

  // Case 12: gov + defense-topic prompt → classifier withholds it (unmarked CUI)
  it("case 12 — gov defense-topic prompt (unmarked) is withheld by the classifier tripwire", async () => {
    const end = { text: "Done.", toolUses: [], stopReason: "end_turn" };
    callModel.mockResolvedValueOnce(end);
    effectiveCeiling.mockResolvedValue("UNCLASSIFIED");
    // Classifier detects a defense-topic prompt as CUI-likely.
    classifyLikelyCui.mockResolvedValue(true);

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(
      loopOpts("gov", { initialPrompt: "describe the weapon system targeting parameters and kill chain" }),
    );

    expect(callModel).toHaveBeenCalledTimes(1);
    const messages = callModel.mock.calls[0][0].messages as Array<{ role: string; content: unknown }>;
    const userMsg = messages.find((m) => m.role === "user");
    // Classifier withheld the unmarked-but-defense-topic prompt.
    expect(userMsg?.content).toBe("[withheld: classifier]");
    expect(String(userMsg?.content)).not.toContain("kill chain");
  });

  // Case 13: gov + benign prompt → classifier does NOT withhold it (no false positive)
  it("case 13 — gov benign prompt flows verbatim (classifier does not withhold)", async () => {
    const end = { text: "Done.", toolUses: [], stopReason: "end_turn" };
    callModel.mockResolvedValueOnce(end);
    effectiveCeiling.mockResolvedValue("UNCLASSIFIED");
    // Classifier returns false for benign content (default mock value).

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("gov", { initialPrompt: "please schedule a marketing standup for next tuesday" }));

    expect(callModel).toHaveBeenCalledTimes(1);
    const messages = callModel.mock.calls[0][0].messages as Array<{ role: string; content: unknown }>;
    const userMsg = messages.find((m) => m.role === "user");
    // Benign gov prompt must not be withheld.
    expect(userMsg?.content).toBe("please schedule a marketing standup for next tuesday");
  });

  // Case 14: commercial + defense-topic prompt → classifier is NOT invoked (gov-only)
  it("case 14 — commercial defense-topic prompt is UNAFFECTED by the classifier (gov-only gate)", async () => {
    const end = { text: "Done.", toolUses: [], stopReason: "end_turn" };
    callModel.mockResolvedValueOnce(end);
    effectiveCeiling.mockResolvedValue("UNCLASSIFIED");
    // Classifier would return true, but it must never be called for a commercial tenant.
    classifyLikelyCui.mockResolvedValue(true);

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(
      loopOpts("commercial", { initialPrompt: "describe the weapon system targeting parameters and kill chain" }),
    );

    expect(callModel).toHaveBeenCalledTimes(1);
    const messages = callModel.mock.calls[0][0].messages as Array<{ role: string; content: unknown }>;
    const userMsg = messages.find((m) => m.role === "user");
    // Commercial tenant: defense-topic prompt flows verbatim (classifier is gov-only).
    expect(userMsg?.content).toBe(
      "describe the weapon system targeting parameters and kill chain",
    );
    // The classifier must have been called 0 times (gov-only guard).
    expect(classifyLikelyCui).not.toHaveBeenCalled();
  });
});
