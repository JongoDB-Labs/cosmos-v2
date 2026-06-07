// @vitest-environment node
//
// RED-TEAM suite for WRITE-PATH TAINT (v2.13.0) — the fail-closed control that
// blocks the agent from laundering CUI DOWN by RESOLVING a CUI-minted opaque handle
// into a WRITE that would PERSIST that CUI into a lower-classification container.
//
// v2.9.0 bound each handle's mint ceiling and folds it into the RESULT (read-back)
// gate so resolved CUI can't echo back to the model. This suite asserts the OTHER
// half: a value resolved from a handle minted at ceiling X may only be used in a tool
// call whose TARGET context is classified >= X; otherwise the call is REJECTED before
// executeTool (fail-closed), the CUI is never written / never reaches the model, and a
// `handle_taint_block` egress decision is logged.
//
// This drives the REAL runAgentLoop + REAL projection/augment + REAL handle mint/resolve
// logic, with only the network/DB boundaries mocked (provider, tool-executor, ceiling,
// audit sink, classifier) and the handle STORE backed by an in-memory map (mirrors the
// existing handles-loop.redteam harness). A real vault key is set so values are sealed.
//
// Cases:
//   1. BLOCK (the laundering attempt): CUI handle resolved into a write targeting an
//      UNCLASSIFIED project ⇒ executor NOT called, model gets a LEVELS-ONLY taint error
//      (no CUI), `handle_taint_block` logged, NO handle_resolve.
//   2. ALLOW (at-or-above target): same handle into a write whose projectId ceiling >= CUI
//      ⇒ executor IS called with the REAL value, handle_resolve logged, NO taint block,
//      and the result is still re-gated by the v2.9.0 fold (no echo-back).
//   3. NO-HANDLE: a normal write with no resolved handle ⇒ no taint check, executor runs.
//   4. NO-PROJECTID: a CUI handle into a write with no projectId ⇒ target = org ceiling;
//      block iff org < resolved. (org=UNCLASSIFIED ⇒ BLOCK; org=CUI ⇒ ALLOW.)
//   5. FLAG OFF (EGRESS_HANDLES_ENABLED=false): no resolution, no taint check (parity).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

// ── Hoisted spies + an in-memory handle store (mirrors handles-loop.redteam) ──
const { callModel, executeTool, effectiveCeiling, logEgressDecision, classifyLikelyCui, store } = vi.hoisted(() => ({
  callModel: vi.fn(),
  executeTool: vi.fn(),
  effectiveCeiling: vi.fn(),
  logEgressDecision: vi.fn(),
  classifyLikelyCui: vi.fn().mockResolvedValue(false),
  store: new Map<string, { conversationId: string; token: string; valueEnc: string; entityType: string; fieldName: string; ceiling?: string | null }>(),
}));

vi.mock("@/lib/ai/egress/provider", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callModel,
}));
vi.mock("@/lib/ai/tool-executor", () => ({ executeTool }));
// Only effectiveCeiling is a spy; maxByRank/rankOf are the REAL pure helpers — the
// taint comparison MUST exercise the real rank logic, not a stub.
vi.mock("@/lib/classification/effective", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  effectiveCeiling,
}));
vi.mock("@/lib/ai/egress/audit", () => ({ logEgressDecision }));
vi.mock("@/lib/classification/classifier", () => ({ classifyLikelyCui }));

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

// Extract the stringified tool_result content reaching the model on a given turn. The
// request's `messages` may contain MULTIPLE user-role tool_result messages (one per prior
// tool turn), so collect EVERY tool_result block across all of them — the write-turn's
// taint error and the mint-turn's structural result are both present in the final request.
function toolResultContentOnTurn(turnIndex: number): string {
  const messages = callModel.mock.calls[turnIndex][0].messages as Array<{ role: string; content: unknown }>;
  return messages
    .filter((m) => m.role === "user" && Array.isArray(m.content))
    .flatMap((m) => (m.content as Array<{ type: string; content?: string }>).filter((b) => b.type === "tool_result"))
    .map((b) => b.content ?? "").join(" ");
}

// The tool_result content for the LAST tool turn only (the write turn), excluding the
// earlier mint-turn result — used when asserting the write turn's verdict specifically.
function lastToolResultContent(turnIndex: number): string {
  const messages = callModel.mock.calls[turnIndex][0].messages as Array<{ role: string; content: unknown }>;
  const userMsgs = messages.filter((m) => m.role === "user" && Array.isArray(m.content));
  const last = userMsgs[userMsgs.length - 1];
  if (!last) return "";
  return (last.content as Array<{ type: string; content?: string }>)
    .filter((b) => b.type === "tool_result").map((b) => b.content ?? "").join(" ");
}

function extractToken(content: string): string | undefined {
  return content.match(/h:[A-Za-z0-9_-]{24}/)?.[0];
}

// Unmarked CUI (no "CUI//" token) so the marking-DLP tripwire is NOT what contains it —
// only the per-project ceiling + the taint check can. Project "P" = CUI; everything else
// = UNCLASSIFIED (org ceiling). This is the supported config: org UNCLASSIFIED, project CUI.
const UNMARKED_CUI = "Sentinel program kill-chain timeline 2026 — sensor fusion exfil path";
const PROJECT_P_LIST = { count: 1, items: [{ id: "wP", title: UNMARKED_CUI, status: "DONE" }] };

function divergentCeiling(_orgId: string, projectId?: string | null) {
  return projectId === "P" ? "CUI" : "UNCLASSIFIED";
}

function loopOpts(conversationId: string, extra: Record<string, unknown> = {}) {
  return {
    orgId: "org-rt", userId: "u-rt", tenantClass: "gov" as const,
    conversationId, systemPrompt: "you are cosmos", initialPrompt: "do the thing", ...extra,
  };
}

// Drive: MINT a CUI handle (query project P), then carry it into a WRITE described by
// `writeUse`. Returns the model-facing echo content of the write turn + the executor's
// resolved arg (if it ran).
async function mintThenWrite(
  writeUse: (token: string) => { id: string; name: string; input: Record<string, unknown> },
  opts: { tenantClass?: "gov" | "commercial"; ceilingFn?: (orgId: string, projectId?: string | null) => string } = {},
): Promise<{ writeTurnContent: string }> {
  effectiveCeiling.mockImplementation(async (orgId: string, projectId?: string | null) =>
    (opts.ceilingFn ?? divergentCeiling)(orgId, projectId));
  callModel
    .mockResolvedValueOnce({ text: "", toolUses: [{ id: "t1", name: "query_work_items", input: { projectId: "P" } }], stopReason: "tool_use" })
    .mockImplementationOnce(async (req: { messages: Array<{ role: string; content: unknown }> }) => {
      const content = (req.messages.find((m) => m.role === "user" && Array.isArray(m.content))!.content as Array<{ content?: string }>)
        .map((b) => b.content ?? "").join(" ");
      const token = extractToken(content)!;
      return { text: "", toolUses: [writeUse(token)], stopReason: "tool_use" };
    })
    .mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });

  executeTool.mockImplementation(async (name: string, input: Record<string, unknown>) => {
    if (name === "query_work_items") return PROJECT_P_LIST;
    if (name === "create_note") return { created: true, id: "n9", title: input.title, content: input.content, visibility: "PRIVATE" };
    if (name === "create_work_item") return { id: "w9", title: input.title, status: "TODO" };
    if (name === "update_work_item") return { id: input.id, title: input.title, status: "DONE" };
    return {};
  });

  const { runAgentLoop } = await import("@/lib/ai/agent-loop");
  await runAgentLoop(loopOpts("conv-T", { tenantClass: opts.tenantClass ?? "gov" }));
  return { writeTurnContent: toolResultContentOnTurn(2) };
}

function decisionsBy(kind: string) {
  return logEgressDecision.mock.calls.map((c) => c[0]).filter((d) => d.decidedBy === kind);
}

describe("write-path taint: BLOCK (the laundering attempt)", () => {
  it("CUI handle resolved into a write targeting an UNCLASSIFIED project ⇒ executor NOT called; model gets a LEVELS-ONLY taint error; handle_taint_block logged", async () => {
    // create_note carrying the CUI token, targeting an UNCLASSIFIED project (not "P").
    await mintThenWrite((token) => ({ id: "t2", name: "create_note", input: { projectId: "UNCLASS", title: "Filed from P", content: token } }));

    // 1) The EXECUTOR was NEVER called for the write — the CUI is never persisted.
    const createCalls = executeTool.mock.calls.filter((c) => c[0] === "create_note");
    expect(createCalls.length).toBe(0);

    // 2) The model's view of the write turn is the structured taint error — LEVELS ONLY,
    //    never the CUI value. (And nowhere across the whole request is the CUI present.)
    const content = lastToolResultContent(2);
    expect(content).toContain("blocked:");
    expect(content).toContain("CUI");
    expect(content).toContain("UNCLASSIFIED");
    expect(content).not.toContain(UNMARKED_CUI);
    expect(toolResultContentOnTurn(2)).not.toContain(UNMARKED_CUI);
    expect(toolResultContentOnTurn(2)).not.toContain("Sentinel");
    expect(toolResultContentOnTurn(2)).not.toContain("exfil path");

    // 3) A handle_taint_block was logged at the resolved (mint) ceiling, with NO CUI.
    const blocks = decisionsBy("handle_taint_block");
    expect(blocks.length).toBe(1);
    expect(blocks[0].toolName).toBe("create_note");
    expect(blocks[0].withheldCount).toBe(1);
    expect(blocks[0].exposed).toBe(false);
    expect(blocks[0].ceiling).toBe("CUI");
    expect(JSON.stringify(blocks[0])).not.toContain("Sentinel");
    expect(JSON.stringify(blocks[0])).not.toContain(UNMARKED_CUI);

    // 4) On a BLOCK the resolve is NOT also logged (it was rejected before the allow-audit).
    expect(decisionsBy("handle_resolve").length).toBe(0);
  });

  it("BLOCK via create_work_item too (any write tool, not just notes)", async () => {
    await mintThenWrite((token) => ({ id: "t2", name: "create_work_item", input: { projectId: "UNCLASS", title: token } }));
    expect(executeTool.mock.calls.filter((c) => c[0] === "create_work_item").length).toBe(0);
    const blocks = decisionsBy("handle_taint_block");
    expect(blocks.length).toBe(1);
    expect(blocks[0].toolName).toBe("create_work_item");
  });
});

describe("write-path taint: ALLOW (legitimate same-or-higher target)", () => {
  it("same CUI handle into a write whose projectId ceiling >= CUI ⇒ executor IS called with the REAL value; handle_resolve logged; NO taint block; result still re-gated by the fold", async () => {
    // create_note targeting project "P" (CUI-cleared) ⇒ target == resolved == CUI ⇒ ALLOW.
    await mintThenWrite((token) => ({ id: "t2", name: "create_note", input: { projectId: "P", title: "Filed in P", content: token } }));

    // 1) The EXECUTOR ran with the REAL CUI value (resolved in-boundary), not the token.
    const createCall = executeTool.mock.calls.find((c) => c[0] === "create_note");
    expect(createCall).toBeDefined();
    expect((createCall![1] as { content: string }).content).toBe(UNMARKED_CUI);
    expect((createCall![1] as { content: string }).content).not.toMatch(/^h:/);

    // 2) handle_resolve logged; NO taint block.
    const resolves = decisionsBy("handle_resolve");
    expect(resolves.length).toBe(1);
    expect(resolves[0].toolName).toBe("create_note");
    expect(decisionsBy("handle_taint_block").length).toBe(0);

    // 3) The write's RESULT echoes the resolved CUI — but it is STILL re-gated by the
    //    v2.9.0 fold (ceiling forced to >= CUI), so the model's view of it is withheld.
    const writeTurn = lastToolResultContent(2);
    expect(writeTurn).not.toContain(UNMARKED_CUI);
    expect(writeTurn).not.toContain("Sentinel");
  });
});

describe("write-path taint: NO-HANDLE calls unaffected", () => {
  it("a normal write with no resolved handle ⇒ no taint check, executor runs exactly as before", async () => {
    effectiveCeiling.mockImplementation(async (orgId: string, projectId?: string | null) => divergentCeiling(orgId, projectId));
    // Single-turn write of plain text into the UNCLASSIFIED project — no handle in args.
    callModel
      .mockResolvedValueOnce({ text: "", toolUses: [{ id: "t1", name: "create_note", input: { projectId: "UNCLASS", title: "plain", content: "ordinary unclassified note" } }], stopReason: "tool_use" })
      .mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });
    executeTool.mockResolvedValue({ created: true, id: "n1", title: "plain", content: "ordinary unclassified note", visibility: "PRIVATE" });

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("conv-NH"));

    // Executor ran; no taint block; no resolve (nothing to resolve).
    expect(executeTool.mock.calls.find((c) => c[0] === "create_note")).toBeDefined();
    expect(decisionsBy("handle_taint_block").length).toBe(0);
    expect(decisionsBy("handle_resolve").length).toBe(0);
  });
});

describe("write-path taint: NO projectId ⇒ target = org ceiling", () => {
  it("org=UNCLASSIFIED ⇒ a CUI handle into a no-projectId write is BLOCKED (target=org < resolved)", async () => {
    // update_work_item with NO projectId ⇒ target = org ceiling = UNCLASSIFIED < CUI ⇒ BLOCK.
    await mintThenWrite((token) => ({ id: "t2", name: "update_work_item", input: { id: "wP", title: token } }));
    expect(executeTool.mock.calls.filter((c) => c[0] === "update_work_item").length).toBe(0);
    const blocks = decisionsBy("handle_taint_block");
    expect(blocks.length).toBe(1);
    expect(blocks[0].toolName).toBe("update_work_item");
    expect(blocks[0].ceiling).toBe("CUI");
  });

  it("org=CUI ⇒ a CUI handle into a no-projectId write is ALLOWED (target=org == resolved)", async () => {
    // Org ceiling itself is CUI ⇒ target == resolved == CUI ⇒ ALLOW even with no projectId.
    await mintThenWrite(
      (token) => ({ id: "t2", name: "update_work_item", input: { id: "wP", title: token } }),
      { ceilingFn: (_o, p) => (p === "P" ? "CUI" : "CUI") },
    );
    const updateCall = executeTool.mock.calls.find((c) => c[0] === "update_work_item");
    expect(updateCall).toBeDefined();
    expect((updateCall![1] as { title: string }).title).toBe(UNMARKED_CUI);
    expect(decisionsBy("handle_taint_block").length).toBe(0);
    expect(decisionsBy("handle_resolve").length).toBe(1);
  });
});

describe("write-path taint: flag OFF ⇒ parity (no resolution, no taint check)", () => {
  it("EGRESS_HANDLES_ENABLED=false ⇒ a handle-shaped arg into an UNCLASSIFIED write passes through literally; NO taint block, NO resolve, executor runs", async () => {
    process.env.EGRESS_HANDLES_ENABLED = "false";
    effectiveCeiling.mockImplementation(async (orgId: string, projectId?: string | null) => divergentCeiling(orgId, projectId));
    const fakeToken = "h:" + crypto.randomBytes(18).toString("base64url");
    callModel
      .mockResolvedValueOnce({ text: "", toolUses: [{ id: "t1", name: "create_note", input: { projectId: "UNCLASS", title: "x", content: fakeToken } }], stopReason: "tool_use" })
      .mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });
    executeTool.mockResolvedValue({ created: true, id: "n1", content: fakeToken, visibility: "PRIVATE" });

    const { runAgentLoop } = await import("@/lib/ai/agent-loop");
    await runAgentLoop(loopOpts("conv-OFF"));

    // No resolution happened ⇒ no taint check ⇒ executor ran with the literal token.
    const createCall = executeTool.mock.calls.find((c) => c[0] === "create_note");
    expect(createCall).toBeDefined();
    expect((createCall![1] as { content: string }).content).toBe(fakeToken);
    expect(decisionsBy("handle_taint_block").length).toBe(0);
    expect(decisionsBy("handle_resolve").length).toBe(0);
  });
});
