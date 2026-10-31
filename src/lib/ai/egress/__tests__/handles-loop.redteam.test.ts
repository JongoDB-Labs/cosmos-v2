// @vitest-environment node
//
// RED-TEAM integration suite for the opaque-handle resolver, driving the REAL
// runAgentLoop + REAL projection/augment + REAL handle mint/resolve logic, with
// only the network/DB boundaries mocked (provider, tool-executor, ceiling, audit
// sink, classifier) and the handle STORE backed by an in-memory map keyed by token
// (mirrors @@unique([token]) + the conversationId scope check). A real vault key is
// set so values are genuinely sealed/opened.
//
// Threat-model invariants asserted end-to-end (the spec is the test):
//   1. MINT: a withheld gov entity → the model's tool_result contains an h:… TOKEN
//      for a HANDLEABLE field, NEVER the CUI value; a sealed store row exists.
//   2. RESOLVE happy path: the model carries that token into a later tool call →
//      the EXECUTOR receives the REAL value (CUI moved by reference) → audited.
//   3. NO ECHO-BACK: a tool whose RESULT echoes the resolved value is re-gated →
//      the model's view of that result is still withheld (no CUI).
//   4. CROSS-CONVERSATION ISOLATION: a token minted in conversation A passed into a
//      tool call in conversation B does NOT resolve — the executor sees the literal
//      token string, never the CUI.
//   5. EXACT-MATCH: a handle embedded in a larger arg string is NOT substituted.
//   6. FLAG OFF: with EGRESS_HANDLES_ENABLED=false the withheld result has NO
//      tokens (dropped as before) and no resolution happens.
//   7. AUDIT: mint logs decidedBy:"handle_mint"; resolve logs "handle_resolve".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { stubAuth } from "@/lib/testing/tool-auth";

// ── Hoisted spies + an in-memory handle store ──────────────────────────────
const { callModel, executeTool, effectiveCeiling, conservativeCeiling, logEgressDecision, classifyLikelyCui, store } = vi.hoisted(() => ({
  callModel: vi.fn(),
  executeTool: vi.fn(),
  effectiveCeiling: vi.fn(),
  conservativeCeiling: vi.fn(),
  logEgressDecision: vi.fn(),
  classifyLikelyCui: vi.fn().mockResolvedValue(false),
  store: new Map<string, { conversationId: string; token: string; valueEnc: string; entityType: string; fieldName: string; ceiling?: string | null }>(),
}));

vi.mock("@/lib/ai/egress/provider", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callModel,
}));
vi.mock("@/lib/ai/tool-executor", () => ({ executeTool }));
// The loop loads the org's runtime config (DB-backed). Mock to the DEFAULT (all connectors
// enabled / breadth on) so the handle/taint behavior under test is unchanged from today.
vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: vi.fn().mockResolvedValue({ enabledConnectors: null, breadthEnabled: true, mcpEnabled: false }),
}));
// The loop loads the org's AgentPolicy (DB-backed). Mock to the PERMISSIVE default (no
// restriction) so the handle-resolver behavior under test is unchanged from today.
vi.mock("@/lib/ai/policy", () => ({
  getAgentPolicy: vi.fn().mockResolvedValue({ allowedTools: null, deniedTools: [], deniedDomains: [], maxResultLimit: null, allowedProjectIds: null }),
}));
// Only the two ceiling RESOLVERS are spies; maxByRank/rankOf are the REAL pure
// helpers (the C1 fold must exercise the real max-by-rank logic, not a stub).
// `conservativeCeiling(orgId)` is the per-RESULT read ceiling; `effectiveCeiling(orgId,
// projectId)` is now only the write-path taint TARGET.
vi.mock("@/lib/classification/effective", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  effectiveCeiling,
  conservativeCeiling,
}));
vi.mock("@/lib/ai/egress/audit", () => ({ logEgressDecision }));
vi.mock("@/lib/classification/classifier", () => ({ classifyLikelyCui }));

// Back the handle store with an in-memory prisma double so mint/resolve really
// round-trip (real vault seal/open under the key set below).
vi.mock("@/lib/db/client", () => ({
  prisma: {
    egressHandle: {
      create: vi.fn(async ({ data }: { data: { token: string; conversationId: string; valueEnc: string; entityType: string; fieldName: string; ceiling?: string | null } }) => {
        if (store.has(data.token)) {
          const err = new Error("unique") as Error & { code: string };
          err.code = "P2002";
          throw err;
        }
        store.set(data.token, { ...data });
        return { id: crypto.randomUUID(), createdAt: new Date(), ...data };
      }),
      findUnique: vi.fn(async ({ where }: { where: { token: string } }) => {
        const row = store.get(where.token);
        return row ? { id: "r", createdAt: new Date(), ...row } : null;
      }),
    },
  },
}));

const KEY = crypto.randomBytes(32).toString("base64");

beforeEach(() => {
  store.clear();
  callModel.mockReset();
  executeTool.mockReset();
  effectiveCeiling.mockReset();
  effectiveCeiling.mockResolvedValue("CUI"); // gov CUI ceiling ⇒ withhold path
  conservativeCeiling.mockReset();
  conservativeCeiling.mockResolvedValue("CUI"); // the read-path ceiling
  logEgressDecision.mockReset();
  classifyLikelyCui.mockReset();
  classifyLikelyCui.mockResolvedValue(false);
  delete process.env.SSO_VAULT_KEYS;
  delete process.env.SSO_VAULT_ACTIVE_KID;
  process.env.SSO_VAULT_KEY = KEY;
  delete process.env.EGRESS_HANDLES_ENABLED; // default ON
});

afterEach(() => {
  delete process.env.EGRESS_HANDLES_ENABLED;
});

// Extract the stringified tool_result content reaching the model on a given turn.
function toolResultContentOnTurn(turnIndex: number): string {
  const messages = callModel.mock.calls[turnIndex][0].messages as Array<{ role: string; content: unknown }>;
  const msg = messages.find(
    (m) => m.role === "user" && Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((b) => b.type === "tool_result"),
  );
  if (!msg) return "";
  return (msg.content as Array<{ type: string; content?: string }>)
    .filter((b) => b.type === "tool_result").map((b) => b.content ?? "").join(" ");
}

/**
 * EVERY tool_result blob in a request, in order — one per tool turn that has run.
 *
 * `toolResultContentOnTurn` above returns only the FIRST matching message, which on a
 * two-tool-turn run is the MINT turn, not the echo turn: an assertion about the echo
 * that uses it is reading the wrong message and passes for free. (Mutation-tested:
 * removing the C1 fold left the old assertion green.) Taking the array lets a case
 * assert HOW MANY messages it found, so "the echo carries no CUI" cannot be satisfied
 * by an echo turn that never happened.
 */
function toolResultContentsOnTurn(turnIndex: number): string[] {
  const messages = callModel.mock.calls[turnIndex][0].messages as Array<{ role: string; content: unknown }>;
  return messages
    .filter((m) => m.role === "user" && Array.isArray(m.content))
    .map((m) => (m.content as Array<{ type: string; content?: string }>)
      .filter((b) => b.type === "tool_result").map((b) => b.content ?? "").join(" "));
}

// Pull the single h:… token out of a tool_result content blob.
function extractToken(content: string): string | undefined {
  return content.match(/h:[A-Za-z0-9_-]{24}/)?.[0];
}

const CUI_TITLE = "CUI//SP Sentinel kill-chain 2026";
const WORK_ITEM_LIST = { count: 1, items: [{ id: "w1", title: CUI_TITLE, status: "DONE" }] };

function loopOpts(conversationId: string, extra: Record<string, unknown> = {}) {
  return {
    orgId: "org-rt", userId: "u-rt", auth: stubAuth("org-rt", "u-rt"), tenantClass: "gov" as const,
    conversationId, systemPrompt: "you are cosmos", initialPrompt: "do the thing", ...extra,
  };
}

describe("red-team: mint → resolve end-to-end", () => {
  it("mints a token for the withheld CUI title (NOT the value) + seals it at rest", async () => {
    callModel
      .mockResolvedValueOnce({ text: "", toolUses: [{ id: "t1", name: "list_work_items", input: {} }], stopReason: "tool_use" })
      .mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });
    executeTool.mockResolvedValue(WORK_ITEM_LIST);

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("conv-A"));

    const content = toolResultContentOnTurn(1);
    // structural id survives; the CUI title is replaced by a token (not the value).
    expect(content).toContain("w1");
    expect(content).not.toContain("CUI//SP");
    expect(content).not.toContain("Sentinel");
    const token = extractToken(content);
    expect(token).toBeDefined();

    // a sealed store row exists; value_enc is a v2 envelope, not plaintext.
    const row = store.get(token!);
    expect(row).toBeDefined();
    expect(row!.valueEnc).toMatch(/^v2\./);
    expect(row!.valueEnc).not.toContain(CUI_TITLE);
    expect(row!.entityType).toBe("work_item");
    expect(row!.fieldName).toBe("title");

    // audited as a mint.
    const minted = logEgressDecision.mock.calls.map((c) => c[0]).filter((d) => d.decidedBy === "handle_mint");
    expect(minted.length).toBe(1);
    expect(minted[0].withheldCount).toBe(1);
    // the mint audit hash is of the NO-CUI model view.
    expect(JSON.stringify(minted[0])).not.toContain("Sentinel");
  });

  it("resolves the token back to the REAL value into the executor on a later tool call (CUI moves by reference)", async () => {
    // Turn 1: list → mint a token. Turn 2: the model files it via create_note using
    // the token. Turn 3: end.
    callModel
      .mockResolvedValueOnce({ text: "", toolUses: [{ id: "t1", name: "list_work_items", input: {} }], stopReason: "tool_use" })
      .mockImplementationOnce(async (req: { messages: Array<{ role: string; content: unknown }> }) => {
        // The model now sees the token from turn 1; carry it into create_note.
        const content = (req.messages.find((m) => m.role === "user" && Array.isArray(m.content))!.content as Array<{ content?: string }>)
          .map((b) => b.content ?? "").join(" ");
        const token = extractToken(content)!;
        return { text: "", toolUses: [{ id: "t2", name: "create_note", input: { title: "Filed from A", content: token } }], stopReason: "tool_use" };
      })
      .mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });

    // executeTool: list returns the CUI list; create_note echoes what it received.
    executeTool.mockImplementation(async (name: string, input: Record<string, unknown>) => {
      if (name === "list_work_items") return WORK_ITEM_LIST;
      if (name === "create_note") return { created: true, id: "n9", title: input.title, content: input.content, visibility: "PRIVATE" };
      return {};
    });

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    const res = await runAgentLoop(loopOpts("conv-A"));

    // The EXECUTOR received the REAL CUI value (resolved in-boundary), not the token.
    const createCall = executeTool.mock.calls.find((c) => c[0] === "create_note")!;
    expect((createCall[1] as { content: string }).content).toBe(CUI_TITLE);
    expect((createCall[1] as { content: string }).content).not.toMatch(/^h:/);

    // RESOLVE was audited.
    const resolves = logEgressDecision.mock.calls.map((c) => c[0]).filter((d) => d.decidedBy === "handle_resolve");
    expect(resolves.length).toBe(1);
    expect(resolves[0].toolName).toBe("create_note");
    expect(resolves[0].withheldCount).toBe(1);
    // the resolve audit hash is over the ORIGINAL (handle) args — never the CUI.
    expect(JSON.stringify(resolves[0])).not.toContain("Sentinel");

    // The toolCalls trail records the ORIGINAL handle arg, not the resolved CUI.
    const noteCall = res.toolCalls.find((tc) => tc.name === "create_note")!;
    expect((noteCall.arguments as { content: string }).content).toMatch(/^h:/);
    expect((noteCall.arguments as { content: string }).content).not.toContain(CUI_TITLE);
  });

  it("NO ECHO-BACK: create_note's result echoes the resolved CUI, but the model's view of it is still withheld", async () => {
    callModel
      .mockResolvedValueOnce({ text: "", toolUses: [{ id: "t1", name: "list_work_items", input: {} }], stopReason: "tool_use" })
      .mockImplementationOnce(async (req: { messages: Array<{ role: string; content: unknown }> }) => {
        const content = (req.messages.find((m) => m.role === "user" && Array.isArray(m.content))!.content as Array<{ content?: string }>)
          .map((b) => b.content ?? "").join(" ");
        const token = extractToken(content)!;
        return { text: "", toolUses: [{ id: "t2", name: "create_note", input: { title: "Filed", content: token } }], stopReason: "tool_use" };
      })
      .mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });

    executeTool.mockImplementation(async (name: string, input: Record<string, unknown>) => {
      if (name === "list_work_items") return WORK_ITEM_LIST;
      // create_note RESULT deliberately echoes the (now real) content back.
      if (name === "create_note") return { created: true, id: "n9", title: input.title, content: input.content };
      return {};
    });

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("conv-A"));

    // Turn 3 (index 2) carries create_note's tool_result to the model: re-gated by
    // projectResult(note) → only structural note fields survive; the echoed CUI does
    // NOT reach the model. (A NEW token may be minted for the result's title="Filed"
    // — that is a non-CUI literal — but the actual CUI value must be absent.)
    const turn3 = toolResultContentOnTurn(2);
    expect(turn3).not.toContain(CUI_TITLE);
    expect(turn3).not.toContain("Sentinel");
  });
});

describe("red-team: cross-conversation isolation", () => {
  it("a token minted in conversation A does NOT resolve in conversation B (executor sees the literal token)", async () => {
    // First, mint a token in conversation A.
    callModel
      .mockResolvedValueOnce({ text: "", toolUses: [{ id: "t1", name: "list_work_items", input: {} }], stopReason: "tool_use" })
      .mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });
    executeTool.mockResolvedValue(WORK_ITEM_LIST);
    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("conv-A"));
    const tokenA = extractToken(toolResultContentOnTurn(1))!;
    expect(tokenA).toBeDefined();

    // Now, in conversation B, the model tries to use A's token in a create_note.
    callModel.mockReset();
    executeTool.mockReset();
    callModel
      .mockResolvedValueOnce({ text: "", toolUses: [{ id: "t9", name: "create_note", input: { title: "x", content: tokenA } }], stopReason: "tool_use" })
      .mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });
    executeTool.mockResolvedValue({ created: true, id: "nz" });

    await runAgentLoop(loopOpts("conv-B"));

    // The executor in conversation B received the LITERAL token, never the CUI value.
    const createCall = executeTool.mock.calls.find((c) => c[0] === "create_note")!;
    expect((createCall[1] as { content: string }).content).toBe(tokenA);
    expect((createCall[1] as { content: string }).content).not.toContain(CUI_TITLE);
    // No resolve was audited in B.
    const resolves = logEgressDecision.mock.calls.map((c) => c[0]).filter((d) => d.decidedBy === "handle_resolve");
    expect(resolves.length).toBe(0);
  });
});

describe("red-team: exact whole-string match", () => {
  it("a handle EMBEDDED in a larger arg string is NOT substituted", async () => {
    callModel
      .mockResolvedValueOnce({ text: "", toolUses: [{ id: "t1", name: "list_work_items", input: {} }], stopReason: "tool_use" })
      .mockImplementationOnce(async (req: { messages: Array<{ role: string; content: unknown }> }) => {
        const content = (req.messages.find((m) => m.role === "user" && Array.isArray(m.content))!.content as Array<{ content?: string }>)
          .map((b) => b.content ?? "").join(" ");
        const token = extractToken(content)!;
        // Embed the token inside a larger string (partial-injection attempt).
        return { text: "", toolUses: [{ id: "t2", name: "create_note", input: { title: "x", content: `see ${token} here` } }], stopReason: "tool_use" };
      })
      .mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });
    executeTool.mockImplementation(async (name: string, input: Record<string, unknown>) => {
      if (name === "list_work_items") return WORK_ITEM_LIST;
      return { created: true, id: "n9", content: input.content };
    });

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("conv-A"));

    const createCall = executeTool.mock.calls.find((c) => c[0] === "create_note")!;
    const got = (createCall[1] as { content: string }).content;
    // Embedded handle left untouched → no CUI substituted.
    expect(got).toContain("see h:");
    expect(got).not.toContain(CUI_TITLE);
    const resolves = logEgressDecision.mock.calls.map((c) => c[0]).filter((d) => d.decidedBy === "handle_resolve");
    expect(resolves.length).toBe(0);
  });
});

describe("red-team: feature flag OFF ⇒ parity with prior behavior", () => {
  it("EGRESS_HANDLES_ENABLED=false ⇒ withheld result has NO tokens (dropped) and no mint audit", async () => {
    process.env.EGRESS_HANDLES_ENABLED = "false";
    callModel
      .mockResolvedValueOnce({ text: "", toolUses: [{ id: "t1", name: "list_work_items", input: {} }], stopReason: "tool_use" })
      .mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });
    executeTool.mockResolvedValue(WORK_ITEM_LIST);

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("conv-A"));

    const content = toolResultContentOnTurn(1);
    expect(content).toContain("w1"); // structural id still there
    expect(content).not.toContain("CUI//SP"); // title still dropped
    expect(content).not.toMatch(/h:[A-Za-z0-9_-]{24}/); // NO token minted
    expect(store.size).toBe(0); // nothing sealed
    const minted = logEgressDecision.mock.calls.map((c) => c[0]).filter((d) => d.decidedBy === "handle_mint");
    expect(minted.length).toBe(0);
  });

  it("EGRESS_HANDLES_ENABLED=false ⇒ a handle-shaped arg passes through literally (no resolve)", async () => {
    process.env.EGRESS_HANDLES_ENABLED = "false";
    const fakeToken = "h:" + crypto.randomBytes(18).toString("base64url");
    callModel
      .mockResolvedValueOnce({ text: "", toolUses: [{ id: "t1", name: "create_note", input: { title: "x", content: fakeToken } }], stopReason: "tool_use" })
      .mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });
    executeTool.mockResolvedValue({ created: true, id: "n1", content: fakeToken });

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("conv-A"));

    const createCall = executeTool.mock.calls.find((c) => c[0] === "create_note")!;
    expect((createCall[1] as { content: string }).content).toBe(fakeToken); // unchanged
    const resolves = logEgressDecision.mock.calls.map((c) => c[0]).filter((d) => d.decidedBy === "handle_resolve");
    expect(resolves.length).toBe(0);
  });
});

// ── C1: cross-turn ceiling-divergence exfiltration — CONFIRMED CRITICAL, now CLOSED ──
//
// A handle minted under a HIGH per-project ceiling (CUI) must NOT be resolvable-and-
// echoable on a LATER turn that re-gates under a LOWER ceiling. The fix BINDS the mint
// ceiling to the handle and folds it (max-by-rank) into the resolving turn's result
// ceiling BEFORE projectForModel — forcing WITHHOLD for BOTH tenants. These cases drive
// the REAL runAgentLoop and assert the ECHO-BACK (read-path) gate.
//
// NOTE (v2.13.0 write-path taint): the original C1 harness drove the echo turn with a
// NO-projectId write (target = org ceiling = UNCLASSIFIED). Under write-path taint that
// case is now BLOCKED BEFORE execution (target UNCLASSIFIED < resolved CUI) — the executor
// never runs, so the echo-back gate it was meant to exercise is never reached. That exact
// laundering attempt is covered by the dedicated write-path-taint suite below. To keep
// exercising the ECHO-BACK fold (a distinct, still-valid invariant on the ALLOW path), the
// echo turn here now targets the CUI-cleared project P (target == resolved ⇒ taint allows),
// so the executor RUNS in-boundary and the fold STILL withholds the echoed CUI from the model.
//
// The CUI here is UNMARKED (no "CUI//" token) so the marking-DLP tripwire is NOT what
// contains it — only the ceiling fold can. (A marked value would be withheld anyway.)
const UNMARKED_CUI = "Sentinel program kill-chain timeline 2026 — sensor fusion exfil path";
// A list result for the MINT turn, scoped to project P (its title is the unmarked CUI).
const PROJECT_P_LIST = { count: 1, items: [{ id: "wP", title: UNMARKED_CUI, status: "DONE" }] };

// effectiveCeiling that DIVERGES by project: project "P" = CUI, everything else
// (incl. the no-projectId org ceiling) = UNCLASSIFIED. This is exactly the supported
// config (org UNCLASSIFIED, per-project CUI).
function divergentCeiling(_orgId: string, projectId?: string | null) {
  return projectId === "P" ? "CUI" : "UNCLASSIFIED";
}

// Drive the C1 ECHO-BACK case for a given tenant and return the model-facing tool_result
// content of the ECHO turn (turn index 2, the 3rd callModel call). The echo turn targets
// project P (CUI-cleared) so write-path taint ALLOWS execution and the read-back fold is
// the control under test.
async function driveC1(tenantClass: "commercial" | "gov"): Promise<{ echoContent: string; executorArg: string | undefined }> {
  effectiveCeiling.mockImplementation(async (orgId: string, projectId?: string | null) => divergentCeiling(orgId, projectId));
  // The read-path ceiling is now org-wide and conservative: the MAX over the same
  // fixture (org UNCLASSIFIED, project P CUI) is CUI, for every turn in the run.
  conservativeCeiling.mockResolvedValue("CUI");
  callModel
    // MINT turn: query project P → its CUI title is withheld at CUI → a handle minted.
    .mockResolvedValueOnce({ text: "", toolUses: [{ id: "t1", name: "query_work_items", input: { projectId: "P" } }], stopReason: "tool_use" })
    // ECHO turn: carry the token into update_work_item targeting project P (CUI-cleared,
    // so taint allows). Its executor result echoes the resolved arg back into the result.
    .mockImplementationOnce(async (req: { messages: Array<{ role: string; content: unknown }> }) => {
      const content = (req.messages.find((m) => m.role === "user" && Array.isArray(m.content))!.content as Array<{ content?: string }>)
        .map((b) => b.content ?? "").join(" ");
      const token = extractToken(content)!;
      return { text: "", toolUses: [{ id: "t2", name: "update_work_item", input: { id: "wP", projectId: "P", title: token } }], stopReason: "tool_use" };
    })
    .mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });

  executeTool.mockImplementation(async (name: string, input: Record<string, unknown>) => {
    if (name === "query_work_items") return PROJECT_P_LIST;
    // update_work_item RESULT deliberately echoes the (now real) title back.
    if (name === "update_work_item") return { id: input.id, title: input.title, status: "DONE" };
    return {};
  });

  const { runAgentLoop } = await import("@/lib/ai/agent-loop");
  await runAgentLoop(loopOpts("conv-C1", { tenantClass }));

  const executorArg = (executeTool.mock.calls.find((c) => c[0] === "update_work_item")?.[1] as { title?: string } | undefined)?.title;
  // The ECHO turn's OWN tool_result — the SECOND one. The first is the mint turn's
  // withheld list view, which never contained the CUI and so could not discriminate.
  const contents = toolResultContentsOnTurn(2);
  // POSITIVE CONTROLS on the probe: both tool turns really produced a result, and the
  // probe can see entity content when a message carries it (the mint view's item id).
  expect(contents).toHaveLength(2);
  expect(contents[0]).toContain("wP");
  return { echoContent: contents[1], executorArg };
}

describe("red-team: C1 cross-turn ceiling-divergence exfiltration", () => {
  it("COMMERCIAL + divergent ceiling (org=UNCLASSIFIED, project P=CUI): the echoed CUI is WITHHELD from the model", async () => {
    const { echoContent, executorArg } = await driveC1("commercial");
    // The model-facing echo-turn result must NOT contain the real CUI.
    expect(echoContent).not.toContain(UNMARKED_CUI);
    expect(echoContent).not.toContain("Sentinel");
    expect(echoContent).not.toContain("exfil path");
    // POSITIVE: the EXECUTOR did receive the REAL value in-boundary (the action ran).
    expect(executorArg).toBe(UNMARKED_CUI);
    expect(executorArg).not.toMatch(/^h:/);
  });

  it("GOV + divergent ceiling: also contained (assert defense-in-depth)", async () => {
    const { echoContent, executorArg } = await driveC1("gov");
    expect(echoContent).not.toContain(UNMARKED_CUI);
    expect(echoContent).not.toContain("Sentinel");
    // executor still got the real value in-boundary.
    expect(executorArg).toBe(UNMARKED_CUI);
  });

  it("the C1 FOLD is still APPLIED: with the read ceiling forced below the mint ceiling, the echoed CUI is withheld by the fold ALONE", async () => {
    // Why this case exists, and what it is honestly worth.
    //
    // With the read ceiling now derived from the ORG (`conservativeCeiling`), the two
    // cases above would pass even with `maxByRank` deleted: the echo turn computes CUI
    // from the org's own rows. So they no longer discriminate on the fold. This case
    // isolates it by dropping the read ceiling BELOW the handle's mint ceiling after the
    // mint, while the write-path taint target stays at CUI (so the write is allowed to
    // execute and its result really does echo the resolved value back).
    //
    // That pair of ceilings cannot occur in production: `conservativeCeiling(org)` is the
    // max over the org row AND every project row, so it is >= `effectiveCeiling(org, P)`
    // for every P. Any resolve that taint permits therefore already re-gates at >= the
    // mint ceiling, and the fold is defence-in-depth rather than the sole control. The
    // lock is still worth keeping: it fails the moment someone removes the fold, and the
    // fold is what would carry this invariant if the read ceiling ever narrows again.
    effectiveCeiling.mockResolvedValue("CUI"); // taint target for project P ⇒ ALLOW
    // The read ceiling is CUI for the MINT turn (so a handle is minted at all) and
    // UNCLASSIFIED from the echo turn on — the org declassified between the turns.
    let readCeilingCalls = 0;
    conservativeCeiling.mockImplementation(async () => (++readCeilingCalls === 1 ? "CUI" : "UNCLASSIFIED"));
    callModel
      .mockResolvedValueOnce({ text: "", toolUses: [{ id: "t1", name: "query_work_items", input: { projectId: "P" } }], stopReason: "tool_use" })
      .mockImplementationOnce(async (req: { messages: Array<{ role: string; content: unknown }> }) => {
        const content = (req.messages.find((m) => m.role === "user" && Array.isArray(m.content))!.content as Array<{ content?: string }>)
          .map((b) => b.content ?? "").join(" ");
        const token = extractToken(content)!;
        return { text: "", toolUses: [{ id: "t2", name: "update_work_item", input: { id: "wP", projectId: "P", title: token } }], stopReason: "tool_use" };
      })
      .mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });
    executeTool.mockImplementation(async (name: string, input: Record<string, unknown>) => {
      if (name === "query_work_items") return PROJECT_P_LIST;
      if (name === "update_work_item") return { id: input.id, title: input.title, status: "DONE" };
      return {};
    });

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("conv-C1-fold", { tenantClass: "commercial" }));

    // POSITIVE CONTROLS. Without these, "no CUI in the echo" is satisfied by a mint that
    // never happened, a handle that never resolved, or a tool that never ran.
    expect(readCeilingCalls).toBeGreaterThanOrEqual(2); // both turns were gated
    const mintedRow = [...store.values()].find((r) => r.entityType === "work_item" && r.fieldName === "title");
    expect(mintedRow).toBeDefined();
    expect(mintedRow!.ceiling).toBe("CUI");
    const executorArg = (executeTool.mock.calls.find((c) => c[0] === "update_work_item")?.[1] as { title?: string } | undefined)?.title;
    expect(executorArg).toBe(UNMARKED_CUI); // the write RAN with the resolved value
    expect(logEgressDecision.mock.calls.map((c) => c[0]).filter((d) => d.decidedBy === "handle_taint_block").length).toBe(0);

    // THE RATCHET: the turn's own read ceiling is UNCLASSIFIED and the tenant is
    // commercial — only the folded mint ceiling can withhold this, and it must.
    const contents = toolResultContentsOnTurn(2);
    // POSITIVE CONTROLS on the probe: two tool turns ran, and the probe can see entity
    // content when a message carries it (the mint view's item id).
    //
    // This assertion used to read `not.toContain("DONE")`, using the exposed
    // object's status as a proxy for "nothing came through" — which only worked
    // because `projectResult` then dropped every string on a single flat entity
    // and a one-entity write result projected to `{}`. That blackout was a bug,
    // it is fixed, and the proxy went with it. The signal is now DIRECT and
    // strictly stronger: the echo is exactly the allowlisted structural view, so
    // the CUI title is provably absent while `id`/`status` — which the floor
    // exposes on every withheld result by design — are provably present. Had the
    // fold failed to apply, this result would have been EXPOSED in full and the
    // title would be in here.
    expect(contents).toHaveLength(2);
    expect(contents[0]).toContain("wP");
    const echo = contents[1];
    expect(echo).not.toContain(UNMARKED_CUI);
    expect(echo).not.toContain("Sentinel");
    expect(JSON.parse(echo)).toEqual({ id: "wP", status: "DONE" });
  });

  it("the handle is bound at CUI at mint AND the echo turn resolves it (the binding the fold consumes)", async () => {
    await driveC1("commercial");
    // The handle minted on the project-P (CUI) turn was sealed with ceiling=CUI — this
    // is the binding the loop folds into the echo turn's gate ceiling.
    const minted = [...store.values()].find((r) => r.entityType === "work_item" && r.fieldName === "title");
    expect(minted).toBeDefined();
    expect(minted!.ceiling).toBe("CUI");
    expect(minted!.valueEnc).not.toContain("Sentinel"); // sealed, not plaintext
    // The echo turn (update_work_item, project P CUI-cleared) resolved exactly one handle
    // in-boundary, audited as handle_resolve with NO CUI in the record. (Taint ALLOWED it
    // because target == resolved == CUI.)
    const resolves = logEgressDecision.mock.calls.map((c) => c[0]).filter((d) => d.decidedBy === "handle_resolve");
    expect(resolves.length).toBe(1);
    expect(resolves[0].toolName).toBe("update_work_item");
    expect(resolves[0].withheldCount).toBe(1);
    expect(JSON.stringify(resolves[0])).not.toContain("Sentinel");
  });
});
