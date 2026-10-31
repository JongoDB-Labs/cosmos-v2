// src/lib/ai/__tests__/agent-loop-invalid-id.test.ts
// @vitest-environment node
//
// Regression lock (COSMOS-176): an id the model INVENTED must not crash the turn.
//
// Asked to prep a retro, the assistant called a sprint-data tool with a
// readable-looking but non-uuid projectId ("f9s8d7f9-demo-proj-id") it had never
// resolved, and the user got a raw
// "Invalid `prisma.interval.findFirst()` invocation … invalid input syntax for
// type uuid" instead of an answer.
//
// Guarding the TOOL is not enough, which is what this file exists to prove. The
// loop reads `input.projectId` itself and used to hand it to `effectiveCeiling`,
// which queries `DataClassification.projectId` — a `@db.Uuid` column — AFTER the
// tool has returned and outside anything the tool can catch. So the crash survived
// a tool that refused the very same id, and only a test that drives the LOOP sees
// it.
//
// UPDATED (read-path ceiling fix): the per-RESULT ceiling is now
// `conservativeCeiling(orgId)`, which takes NO projectId, so a model-invented id no
// longer reaches a uuid column from a READ turn at all — a strictly stronger
// position than catching it at the seam. `effectiveCeiling(orgId, projectId)` keeps
// per-project semantics for the WRITE-path taint target, where the id describes
// where the data would land; its uuid guard is locked directly against Postgres in
// classification/__tests__/effective-invalid-id.test.ts, and its use by the loop in
// egress/__tests__/write-path-taint.redteam.test.ts.
//
// Both resolvers are spied but NOT stubbed: the spies delegate to the real
// implementations, so the ceiling query really runs against Postgres. Everything
// else the loop needs for I/O is mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { stubAuth } from "@/lib/testing/tool-auth";

const { runModelTurn, executeTool, effectiveCeiling, conservativeCeiling, getRuntimeConfig, getAgentPolicy, logEgressDecision } =
  vi.hoisted(() => ({
    runModelTurn: vi.fn(),
    executeTool: vi.fn(),
    effectiveCeiling: vi.fn(),
    conservativeCeiling: vi.fn(),
    getRuntimeConfig: vi.fn(),
    getAgentPolicy: vi.fn(),
    logEgressDecision: vi.fn(),
  }));

vi.mock("../egress", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runModelTurn,
  logEgressDecision,
}));
vi.mock("../tool-executor", () => ({ executeTool }));
vi.mock("@/lib/runtime-config", () => ({ getRuntimeConfig }));
vi.mock("../policy", () => ({ getAgentPolicy }));
// Spied so the ARGUMENTS the loop passes can be asserted; the implementations set
// in beforeEach are the real ones, so the DB round-trip is genuine.
vi.mock("@/lib/classification/effective", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  effectiveCeiling,
  conservativeCeiling,
}));

const PERMISSIVE = {
  allowedTools: null,
  deniedTools: [],
  deniedDomains: [],
  maxResultLimit: null,
  allowedProjectIds: null,
};

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "44444444-4444-4444-4444-444444444444";
const HALLUCINATED_ID = "f9s8d7f9-demo-proj-id";
const WELL_FORMED_ID = "33333333-3333-3333-3333-333333333333";

/** One tool turn with `input`, then a final-answer turn. */
function driveOneToolCall(toolName: string, input: Record<string, unknown>, answer: string) {
  runModelTurn
    .mockResolvedValueOnce({
      text: "",
      toolUses: [{ id: "tu1", name: toolName, input }],
      stopReason: "tool_use",
    })
    .mockResolvedValueOnce({ text: answer, toolUses: [], stopReason: "end_turn" });
}

async function runLoop() {
  const { runAgentLoop } = await import("../agent-loop");
  return runAgentLoop({
    orgId: ORG_ID,
    userId: "22222222-2222-2222-2222-222222222222",
    auth: stubAuth(ORG_ID, "22222222-2222-2222-2222-222222222222"),
    tenantClass: "commercial",
    systemPrompt: "sys",
    initialPrompt: "prep me for a retro",
    conversationId: CONVERSATION_ID,
  });
}

describe("runAgentLoop — a model-invented projectId never crashes the turn", () => {
  beforeEach(async () => {
    runModelTurn.mockReset();
    executeTool.mockReset().mockResolvedValue({ error: "projectId is not a valid id." });
    logEgressDecision.mockReset();
    getRuntimeConfig.mockReset().mockResolvedValue({
      enabledConnectors: null,
      breadthEnabled: true,
      mcpEnabled: false,
    });
    getAgentPolicy.mockReset().mockResolvedValue(PERMISSIVE);
    // The REAL classification resolver behind the spy — this talks to Postgres.
    const actual = await vi.importActual<typeof import("@/lib/classification/effective")>(
      "@/lib/classification/effective",
    );
    effectiveCeiling.mockReset().mockImplementation(actual.effectiveCeiling);
    conservativeCeiling.mockReset().mockImplementation(actual.conservativeCeiling);
  });

  it("completes the turn instead of throwing the database's uuid error", async () => {
    driveOneToolCall("generate_interval_brief", { projectId: HALLUCINATED_ID }, "I couldn't find that project.");

    const res = await runLoop();

    expect(res.text).toBe("I couldn't find that project.");
    expect(res.toolCalls).toHaveLength(1);
    // The tool's own refusal is what the model saw — not a database error.
    expect(res.toolCalls[0].result).toEqual({ error: "projectId is not a valid id." });
  });

  it("asks the READ ceiling about the org alone — the invented id never reaches the uuid column", async () => {
    driveOneToolCall("generate_interval_brief", { projectId: HALLUCINATED_ID }, "done");

    await runLoop();

    // POSITIVE CONTROL: the ceiling WAS resolved (0 calls would satisfy the
    // never-called assertion below for free).
    expect(conservativeCeiling).toHaveBeenCalledWith(ORG_ID);
    // And the model's id went nowhere near it. This is the read-path ceiling fix: the
    // gate's ceiling is not a function of anything the model said.
    expect(effectiveCeiling).not.toHaveBeenCalledWith(ORG_ID, HALLUCINATED_ID);
    expect(JSON.stringify(conservativeCeiling.mock.calls)).not.toContain(HALLUCINATED_ID);
  });

  it("treats a well-formed projectId exactly the same way on the read path", async () => {
    driveOneToolCall("generate_interval_brief", { projectId: WELL_FORMED_ID }, "done");

    const res = await runLoop();

    // No over- and no under-rejection: a real id is not special on a READ either, and
    // the turn completes. (Where a real id IS load-bearing — the write-path taint
    // target — is locked in write-path-taint.redteam.test.ts.)
    expect(conservativeCeiling).toHaveBeenCalledWith(ORG_ID);
    expect(effectiveCeiling).not.toHaveBeenCalledWith(ORG_ID, WELL_FORMED_ID);
    expect(res.text).toBe("done");
  });

  it("hands the tool the model's ORIGINAL arguments", async () => {
    driveOneToolCall("generate_interval_brief", { projectId: HALLUCINATED_ID }, "done");

    await runLoop();

    expect(executeTool).toHaveBeenCalledWith(
      "generate_interval_brief",
      { projectId: HALLUCINATED_ID },
      expect.objectContaining({ orgId: ORG_ID }),
    );
  });
});
