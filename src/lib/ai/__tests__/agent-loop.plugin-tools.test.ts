// Plugin-contributed tools in the offered set.
//
// `runAgentLoop` narrows plugin tools by the caller's `opts.tools`, so a
// READONLY chat bot cannot acquire a plugin's writes just because an org has
// the plugin switched on. The chat bots passed only `cosmosTools`, which named
// no plugin tool — so every one was silently dropped and a plugin could
// contribute a tool the assistant offered and the Slack/Teams bots never could.
//
// Fixing that means a caller DOES pass plugin defs in `opts.tools`, and the
// re-add below would then count them twice. A duplicate tool name is an API
// error from the model, so plugin names are subtracted from the caller's list
// first, exactly as connector names are.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { runModelTurn, executeTool, effectiveCeiling, conservativeCeiling, getRuntimeConfig, getAgentPolicy, logEgressDecision, pluginToolDefs } =
  vi.hoisted(() => ({
    runModelTurn: vi.fn(), executeTool: vi.fn(), effectiveCeiling: vi.fn(), conservativeCeiling: vi.fn(), getRuntimeConfig: vi.fn(),
    getAgentPolicy: vi.fn(), logEgressDecision: vi.fn(), pluginToolDefs: vi.fn(),
  }));
vi.mock("../egress", async (importOriginal) => ({ ...(await importOriginal<object>()), runModelTurn, logEgressDecision }));
vi.mock("../tool-executor", () => ({ executeTool }));
vi.mock("@/lib/runtime-config", () => ({ getRuntimeConfig }));
vi.mock("../policy", () => ({ getAgentPolicy }));
vi.mock("../plugin-tools", () => ({ pluginToolDefs }));
vi.mock("@/lib/classification/effective", async (importOriginal) => ({ ...(await importOriginal<object>()), effectiveCeiling, conservativeCeiling }));

import { runAgentLoop } from "../agent-loop";
import { cosmosTools, type ToolDefinition } from "../tools";
import { filterToolsByScope } from "@/lib/chat/tool-filter";
import { stubAuth } from "@/lib/testing/tool-auth";

const PERMISSIVE = { allowedTools: null, deniedTools: [], deniedDomains: [], maxResultLimit: null, allowedProjectIds: null };

/** A plugin's write tool, shaped like whiteboard's. */
const PLUGIN_TOOL: ToolDefinition = {
  name: "create_whiteboard",
  description: "Create a whiteboard.",
  domain: "whiteboard",
  input_schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
} as ToolDefinition;

beforeEach(() => {
  runModelTurn.mockReset(); executeTool.mockReset().mockResolvedValue({ ok: true }); logEgressDecision.mockReset();
  effectiveCeiling.mockReset().mockResolvedValue("UNCLASSIFIED");
  conservativeCeiling.mockReset().mockResolvedValue("UNCLASSIFIED"); // the read-path ceiling
  getRuntimeConfig.mockReset().mockResolvedValue({ enabledConnectors: null, breadthEnabled: true, mcpEnabled: false });
  getAgentPolicy.mockReset().mockResolvedValue(PERMISSIVE);
  pluginToolDefs.mockReset().mockResolvedValue([PLUGIN_TOOL]);
});

async function run(tools?: ToolDefinition[]) {
  runModelTurn.mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });
  await runAgentLoop({
    orgId: "o1", userId: "u1", auth: stubAuth("o1", "u1"), tenantClass: "commercial", conversationId: "c1",
    systemPrompt: "sys", initialPrompt: "hi", ...(tools ? { tools } : {}),
  });
  return (runModelTurn.mock.calls[0][0].tools as { name: string }[]).map((t) => t.name);
}

describe("plugin tools in the offered set", () => {
  it("are offered when the caller passes no list at all (the assistant)", async () => {
    expect(await run(undefined)).toContain("create_whiteboard");
  });

  it("are offered EXACTLY ONCE when the caller names them (the chat bots)", async () => {
    // The whole point of the subtraction: the caller's list and the re-add
    // would otherwise both contribute this name, and a duplicate tool name is
    // an API error from the model.
    const offered = await run([...cosmosTools, PLUGIN_TOOL]);
    expect(offered.filter((n) => n === "create_whiteboard")).toHaveLength(1);
  });

  it("are NOT offered when the caller's list omits them", async () => {
    // The narrowing that makes passing a list safe: an org having a plugin on
    // must not widen what a restricted caller can reach.
    const offered = await run([...cosmosTools]);
    expect(offered).not.toContain("create_whiteboard");
    // Positive control: the caller's own tools really were offered, so the
    // absence above is the narrowing and not an empty offered set.
    expect(offered).toContain("list_projects");
  });

  it("do not reach a READONLY bot, since a plugin write matches no read prefix", async () => {
    const offered = await run(filterToolsByScope("READONLY", [...cosmosTools, PLUGIN_TOOL]));
    expect(offered).not.toContain("create_whiteboard");
    expect(offered).toContain("list_projects");
  });

  it("no duplicate name is ever offered, whatever the caller passes", async () => {
    const offered = await run([...cosmosTools, PLUGIN_TOOL]);
    expect(new Set(offered).size).toBe(offered.length);
  });
});
