// src/lib/ai/__tests__/agent-loop.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted keeps the spies safe to reference inside the hoisted mock factory.
const { runModelTurn, executeTool, effectiveCeiling } = vi.hoisted(() => ({
  runModelTurn: vi.fn(), executeTool: vi.fn(), effectiveCeiling: vi.fn(),
}));
// Mock the SAME specifier agent-loop imports ("./egress" → "../egress" from here)
// so both resolve to the one module id and the mock actually intercepts.
vi.mock("../egress", async (importOriginal) => ({ ...(await importOriginal<object>()), runModelTurn }));
vi.mock("../tool-executor", () => ({ executeTool }));
// The loop resolves each tool result's effective ceiling (DB-backed). Mock it to
// UNCLASSIFIED so a commercial org's tool result is EXPOSED (the enforced policy).
// Keep the real pure helpers (maxByRank/rankOf) so the loop's C1 ceiling fold runs.
vi.mock("@/lib/classification/effective", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  effectiveCeiling,
}));

describe("runAgentLoop (native tool_use)", () => {
  beforeEach(() => {
    runModelTurn.mockReset(); executeTool.mockReset();
    effectiveCeiling.mockReset().mockResolvedValue("UNCLASSIFIED");
  });

  it("runs a tool, projects the result, and returns the final text", async () => {
    runModelTurn
      .mockResolvedValueOnce({ text: "", toolUses: [{ id: "tu1", name: "list_projects", input: {} }], stopReason: "tool_use" })
      .mockResolvedValueOnce({ text: "You have 2 projects.", toolUses: [], stopReason: "end_turn" });
    executeTool.mockResolvedValue({ projects: [{ id: "p1" }, { id: "p2" }] });

    const { runAgentLoop } = await import("../agent-loop");
    const res = await runAgentLoop({
      orgId: "o1", userId: "u1", tenantClass: "commercial",
      systemPrompt: "sys", initialPrompt: "list projects", conversationId: "c1",
    });

    expect(executeTool).toHaveBeenCalledWith("list_projects", {}, { orgId: "o1", userId: "u1", tenantClass: "commercial", conversationId: "c1" });
    expect(res.text).toBe("You have 2 projects.");
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe("list_projects");
    // The 2nd model turn received a tool_result message (native), not a TOOL_CALL string.
    const secondCallMessages = runModelTurn.mock.calls[1][0].messages;
    expect(JSON.stringify(secondCallMessages)).toContain("tool_result");
    // commercial + UNCLASSIFIED ceiling => the result is EXPOSED (not withheld).
    expect(JSON.stringify(secondCallMessages)).toContain("p1");
  });
});

// ── D5 gov-block, LAYER 1 at the AGENT LOOP (the model never SEES a commercial-only
// tool) ─────────────────────────────────────────────────────────────────────────
describe("runAgentLoop — D5 commercial-only tool-list filter", () => {
  beforeEach(() => {
    runModelTurn.mockReset(); executeTool.mockReset();
    effectiveCeiling.mockReset().mockResolvedValue("UNCLASSIFIED");
  });

  async function toolNamesForClass(tenantClass: "gov" | "commercial"): Promise<string[]> {
    const { registerConnector, resetConnectors, getConnectorDescriptors } = await import("../connectors/registry");
    // Snapshot the REAL connectors so we can restore them after (other tests rely on
    // google/github being registered — the registry is a global singleton).
    const saved = [...getConnectorDescriptors()];
    resetConnectors();
    // A commercial-only fixture connector (the Nango case) registered into the live
    // registry the loop reads from.
    registerConnector({
      provider: "broker_fixture",
      availability: "commercial-only",
      toolDefs: [{ name: "broker_fixture_proxy", description: "p", input_schema: { type: "object", properties: {}, required: [] } }],
      execute: async () => ({}),
      egress: {},
    });
    // One turn, no tool use → the loop returns immediately after building `tools`.
    runModelTurn.mockResolvedValueOnce({ text: "ok", toolUses: [], stopReason: "end_turn" });
    const { runAgentLoop } = await import("../agent-loop");
    await runAgentLoop({
      orgId: "o1", userId: "u1", tenantClass,
      systemPrompt: "sys", initialPrompt: "hi", conversationId: "c1",
    });
    const tools = runModelTurn.mock.calls[0][0].tools as { name: string }[];
    // Restore the real registry exactly as it was.
    resetConnectors();
    for (const d of saved) registerConnector(d);
    return tools.map((t) => t.name);
  }

  it("a GOV tenant's model tool list contains NO commercial-only (nango_*-style) tool", async () => {
    const names = await toolNamesForClass("gov");
    expect(names).not.toContain("broker_fixture_proxy");
    // Native tools are still present (the filter only removes commercial-only connectors).
    expect(names).toContain("list_projects");
  });

  it("a COMMERCIAL tenant's model tool list DOES contain the commercial-only tool", async () => {
    const names = await toolNamesForClass("commercial");
    expect(names).toContain("broker_fixture_proxy");
    expect(names).toContain("list_projects");
  });
});
