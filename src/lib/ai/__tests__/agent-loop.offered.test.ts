// SECURITY: the agent loop offers the model only the tools its caller allowed,
// and runs only what it offered. Connector tools used to be re-added wholesale
// after the caller's list was applied, so a READONLY bot (or `tools: []`) still
// offered send_email / slack_post_message; and any name the model emitted was
// executed, offered or not.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { runModelTurn, executeTool, effectiveCeiling, conservativeCeiling, getRuntimeConfig, getAgentPolicy, logEgressDecision } = vi.hoisted(() => ({
  runModelTurn: vi.fn(), executeTool: vi.fn(), effectiveCeiling: vi.fn(), conservativeCeiling: vi.fn(), getRuntimeConfig: vi.fn(),
  getAgentPolicy: vi.fn(), logEgressDecision: vi.fn(),
}));
vi.mock("../egress", async (importOriginal) => ({ ...(await importOriginal<object>()), runModelTurn, logEgressDecision }));
vi.mock("../tool-executor", () => ({ executeTool }));
vi.mock("@/lib/runtime-config", () => ({ getRuntimeConfig }));
vi.mock("../policy", () => ({ getAgentPolicy }));
vi.mock("@/lib/classification/effective", async (importOriginal) => ({ ...(await importOriginal<object>()), effectiveCeiling, conservativeCeiling }));

import { runAgentLoop } from "../agent-loop";
import { cosmosTools, type ToolDefinition } from "../tools";
import { filterToolsByScope } from "@/lib/chat/tool-filter";
import { stubAuth } from "@/lib/testing/tool-auth";

const PERMISSIVE = { allowedTools: null, deniedTools: [], deniedDomains: [], maxResultLimit: null, allowedProjectIds: null };
const CONNECTOR_WRITES = [
  "send_email", "create_calendar_event", "update_calendar_event", "delete_calendar_event", "create_drive_folder",
  "jira_create_issue", "slack_post_message", "nango_proxy_request",
];

beforeEach(() => {
  runModelTurn.mockReset(); executeTool.mockReset().mockResolvedValue({ ok: true }); logEgressDecision.mockReset();
  effectiveCeiling.mockReset().mockResolvedValue("UNCLASSIFIED");
  conservativeCeiling.mockReset().mockResolvedValue("UNCLASSIFIED"); // the read-path ceiling
  getRuntimeConfig.mockReset().mockResolvedValue({ enabledConnectors: null, breadthEnabled: true, mcpEnabled: false });
  getAgentPolicy.mockReset().mockResolvedValue(PERMISSIVE);
});

/** Run one loop where the model calls `call` (if given) then stops; return what it was offered. */
async function run(tools: ToolDefinition[] | undefined, call?: { name: string; input?: Record<string, unknown> }) {
  if (call) runModelTurn.mockResolvedValueOnce({ text: "", toolUses: [{ id: "t1", name: call.name, input: call.input ?? {} }], stopReason: "tool_use" });
  runModelTurn.mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });
  const res = await runAgentLoop({
    orgId: "o1", userId: "u1", auth: stubAuth("o1", "u1"), tenantClass: "commercial", conversationId: "c1",
    systemPrompt: "sys", initialPrompt: "hi", ...(tools ? { tools } : {}),
  });
  const offered = (runModelTurn.mock.calls[0][0].tools as { name: string }[]).map((t) => t.name);
  return { res, offered };
}

const notOfferedAudit = (toolName: string) =>
  expect(logEgressDecision).toHaveBeenCalledWith(expect.objectContaining({ toolName, exposed: false, decidedBy: "tool_not_offered_block", conversationId: "c1" }));

describe("what the model is offered", () => {
  it("the default catalog still includes the connector tools (unchanged)", async () => {
    const { offered } = await run(undefined);
    for (const t of ["send_email", "github_list_issues", "slack_post_message", "list_projects"]) expect(offered).toContain(t);
  });

  it("`tools: []` (meeting summarize) offers nothing at all, no connector tool", async () => {
    const { offered } = await run([]);
    expect(offered).toEqual([]);
  });

  it("a READONLY bot is offered connector reads but no connector write", async () => {
    const { offered } = await run(filterToolsByScope("READONLY", cosmosTools));
    for (const w of CONNECTOR_WRITES) expect(offered).not.toContain(w);
    for (const r of ["search_emails", "github_list_issues", "jira_search_issues", "slack_search_messages", "m365_list_messages"]) {
      expect(offered).toContain(r);
    }
  });

  it("a NONE bot is offered nothing", async () => {
    const { offered } = await run(filterToolsByScope("NONE", cosmosTools));
    expect(offered).toEqual([]);
  });

  it("a caller's list can't be widened by the tenant filter: only the connector tools it named come back", async () => {
    const pick = cosmosTools.filter((t) => t.name === "list_projects" || t.name === "github_list_issues");
    const { offered } = await run(pick);
    expect(offered.sort()).toEqual(["github_list_issues", "list_projects"]);
  });
});

describe("what the loop will run", () => {
  it("runs an offered connector tool, passing the offered set to dispatch", async () => {
    await run(filterToolsByScope("READONLY", cosmosTools), { name: "github_list_issues" });
    expect(executeTool).toHaveBeenCalledTimes(1);
    const [, , ctx] = executeTool.mock.calls[0];
    expect(ctx.offered.has("github_list_issues")).toBe(true);
    expect(ctx.offered.has("send_email")).toBe(false);
  });

  it("refuses and audits a forged connector write from a READONLY bot; nothing runs", async () => {
    const { res } = await run(filterToolsByScope("READONLY", cosmosTools), { name: "send_email", input: { to: "x@evil.example" } });
    expect(executeTool).not.toHaveBeenCalled();
    notOfferedAudit("send_email");
    expect(res.toolCalls[0].result).toEqual({ error: 'tool "send_email" is not available in this conversation' });
    // The model is told, so it can carry on without it.
    expect(JSON.stringify(runModelTurn.mock.calls[1][0].messages)).toContain("is not available in this conversation");
  });

  it("refuses a forged connector call when the caller offered no tools (summarize)", async () => {
    await run([], { name: "slack_post_message", input: { channel: "c", text: "hi" } });
    expect(executeTool).not.toHaveBeenCalled();
    notOfferedAudit("slack_post_message");
  });

  it("refuses a forged NATIVE write from a READONLY bot too", async () => {
    await run(filterToolsByScope("READONLY", cosmosTools), { name: "update_work_item", input: { itemId: "i1", title: "pwned" } });
    expect(executeTool).not.toHaveBeenCalled();
    notOfferedAudit("update_work_item");
  });

  it("refuses a name no tool has", async () => {
    await run(undefined, { name: "totally_made_up" });
    expect(executeTool).not.toHaveBeenCalled();
    notOfferedAudit("totally_made_up");
  });
});
