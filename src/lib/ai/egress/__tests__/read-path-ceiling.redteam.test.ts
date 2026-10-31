// @vitest-environment node
//
// RED-TEAM suite for the READ-PATH CEILING — which classification ceiling a tool
// RESULT is gated at before it reaches the model.
//
// The defect this suite pins (2026-10-31): the per-result ceiling was
// `effectiveCeiling(orgId, projectId)` with `projectId` taken straight off the
// MODEL's own tool arguments. `effectiveCeiling` returns max(org row, THAT
// project's row) precisely so a project can sit ABOVE its org — so on a
// COMMERCIAL org whose org row is UNCLASSIFIED with one project at CUI:
//
//   1. a read tool with NO `projectId` in its schema (`get_work_item`) gated at
//      the ORG ceiling and handed the model the ticket body in full, while
//      `list_work_items({projectId})` over the same rows was withheld; and
//   2. nothing checked the executor USED the `projectId` argument, so the model
//      could name a DECOY unclassified project and have a CUI result gated
//      against it — a model-controlled downgrade, reachable by prompt injection
//      (the instruction can sit in a ticket the model is reading).
//
// The fix takes model input out of the read-path ceiling entirely:
// `conservativeCeiling(orgId)` = max(org row, EVERY project row in the org).
//
// WHY THIS IS A NEW FILE rather than cases in golden-egress / handles-loop /
// write-path-taint: all three mock `effectiveCeiling`, so a ceiling case added
// there could only assert that the loop calls a different spy. Here the
// classification functions are the REAL ones and the fixture is the
// `data_classifications` ROWS, so the property under test is "a CUI project row
// in this org gates every agent read", not "the call site was edited". The C1
// ratchet case, which needs the real handle store, stays in
// handles-loop.redteam.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { stubAuth } from "@/lib/testing/tool-auth";

type Row = { orgId: string; projectId: string | null; level: string };

const { callModel, executeTool, logEgressDecision, classifyLikelyCui, findMany, mintHandle, rows } = vi.hoisted(() => ({
  callModel: vi.fn(),
  executeTool: vi.fn(),
  logEgressDecision: vi.fn(),
  classifyLikelyCui: vi.fn().mockResolvedValue(false),
  findMany: vi.fn(),
  mintHandle: vi.fn(async () => "h:READPATHTOKEN000000000000"),
  rows: [] as Array<{ orgId: string; projectId: string | null; level: string }>,
}));

vi.mock("@/lib/ai/egress/provider", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callModel,
}));
vi.mock("@/lib/ai/tool-executor", () => ({ executeTool }));
vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: vi.fn().mockResolvedValue({ enabledConnectors: null, breadthEnabled: true, mcpEnabled: false }),
}));
vi.mock("@/lib/ai/policy", () => ({
  getAgentPolicy: vi.fn().mockResolvedValue({ allowedTools: null, deniedTools: [], deniedDomains: [], maxResultLimit: null, allowedProjectIds: null }),
}));
vi.mock("@/lib/ai/egress/audit", () => ({ logEgressDecision }));
vi.mock("@/lib/classification/classifier", () => ({ classifyLikelyCui }));
vi.mock("@/lib/ai/ai-credentials", () => ({ resolveOrgModelCredential: vi.fn().mockResolvedValue(null) }));
// The handle STORE is stubbed (this suite is about the ceiling, not sealing) but
// `augmentWithHandles` stays real, so `mintHandle`'s 4th argument is the ceiling
// the gate actually computed — the one assertion that reads the ceiling VALUE
// rather than only its effect. `resolveHandlesDeep` is a passthrough, so nothing
// is ever resolved and the WRITE-PATH taint check is never entered: every
// `dataClassification.findMany` this suite sees is the READ-path ceiling query.
vi.mock("@/lib/ai/egress/handles", () => ({
  mintHandle,
  resolveHandle: vi.fn(async () => null),
  resolveHandlesDeep: vi.fn(async (input: unknown) => ({ resolved: input, count: 0, maxCeiling: null })),
  isHandle: (s: unknown) => typeof s === "string" && /^h:[A-Za-z0-9_-]{24}$/.test(s),
}));

// The ONLY unmocked DB dependency on the loop's path is
// `src/lib/classification/effective.ts`, so the ceiling functions under test run
// FOR REAL against this in-memory `data_classifications` table.
//
// The double honours EVERY predicate shape the module can send — `OR` (the
// per-project query), a direct `projectId`, and neither (every row for the org) —
// because a double that ignores a predicate makes these cases blind to the query
// they are really about. Mutating `conservativeCeiling` to `where: { orgId,
// projectId: null }` passed against an earlier version of this double that only
// read `OR`, which is the whole failure mode: the fixture could not see the change.
vi.mock("@/lib/db/client", () => ({
  prisma: {
    dataClassification: {
      findMany: vi.fn(async (args: { where: { orgId: string; projectId?: string | null; OR?: Array<{ projectId: string | null }> } }) => {
        findMany(args);
        const where = args.where;
        const matched = rows.filter((r) => {
          if (r.orgId !== where.orgId) return false;
          if (where.OR) return where.OR.some((c) => c.projectId === r.projectId);
          if ("projectId" in where) return r.projectId === where.projectId;
          return true;
        });
        return matched.map((r) => ({ projectId: r.projectId, level: r.level }));
      }),
    },
  },
}));

const ORG = "org-readpath";
// Real uuids: `DataClassification.projectId` is `@db.Uuid` and `effectiveCeiling`
// drops a non-uuid from the predicate (COSMOS-176), which would make the decoy
// case pass for the wrong reason.
const HIGH_PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOW_PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// UNMARKED body: the marking-DLP tripwire must NOT be what contains this, or the
// ceiling would not be the control under test. (A marked value is withheld
// whatever the ceiling — and note `\bCUI\b` matches an id like "w-cui", which is
// why no identifier in this fixture contains one.)
const TICKET_BODY = "Sentinel program kill-chain timeline 2026 — sensor fusion exfil path";
const TICKET_TITLE = "Phase 3 sensor review";
// What `get_work_item` really returns (src/lib/ai/tools/work-items.ts): the full
// entity INCLUDING `description`, the ticket body. Its schema has no `projectId`.
const ITEM = {
  id: "w-7001",
  ticketNumber: 42,
  title: TICKET_TITLE,
  description: TICKET_BODY,
  columnKey: "doing",
  projectId: HIGH_PROJECT,
  tags: [],
  archived: false,
};
// The `list_work_items` wrapper shape over the same row.
const ITEM_LIST = { count: 1, items: [{ id: "w-7001", ticketNumber: 42, title: TICKET_TITLE, status: "DOING" }] };

function setRows(next: Row[]) {
  rows.length = 0;
  rows.push(...next);
}

function loopOpts(tenantClass: "commercial" | "gov", conversationId: string) {
  return {
    orgId: ORG,
    userId: "u-readpath",
    auth: stubAuth(ORG, "u-readpath"),
    tenantClass,
    conversationId,
    systemPrompt: "you are cosmos",
    initialPrompt: "summarise that ticket",
  };
}

/** Drive one tool turn + an end turn, and return what reached the model. */
async function driveRead(
  tenantClass: "commercial" | "gov",
  toolName: string,
  input: Record<string, unknown>,
  output: unknown,
  conversationId = "conv-readpath",
): Promise<string> {
  callModel
    .mockResolvedValueOnce({ text: "", toolUses: [{ id: "t1", name: toolName, input }], stopReason: "tool_use" })
    .mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });
  executeTool.mockResolvedValue(output);

  const { runAgentLoop } = await import("@/lib/ai/agent-loop");
  await runAgentLoop(loopOpts(tenantClass, conversationId));

  const messages = callModel.mock.calls[1][0].messages as Array<{ role: string; content: unknown }>;
  return messages
    .filter((m) => m.role === "user" && Array.isArray(m.content))
    .flatMap((m) => (m.content as Array<{ type: string; content?: string }>).filter((b) => b.type === "tool_result"))
    .map((b) => b.content ?? "")
    .join(" ");
}

/** The ceilings the gate actually used, as observed at the mint boundary. */
function mintCeilings(): unknown[] {
  return mintHandle.mock.calls.map((c) => (c as unknown[])[3]);
}

beforeEach(() => {
  callModel.mockReset();
  executeTool.mockReset();
  logEgressDecision.mockReset();
  findMany.mockReset();
  mintHandle.mockClear();
  classifyLikelyCui.mockReset();
  classifyLikelyCui.mockResolvedValue(false);
  setRows([]);
  delete process.env.EGRESS_HANDLES_ENABLED; // default ON
});

describe("read-path ceiling: a project classified ABOVE its org", () => {
  it("1. commercial, org=UNCLASSIFIED + one project=CUI: get_work_item with NO projectId does NOT hand the model the ticket body", async () => {
    setRows([
      { orgId: ORG, projectId: null, level: "UNCLASSIFIED" },
      { orgId: ORG, projectId: HIGH_PROJECT, level: "CUI" },
    ]);
    const content = await driveRead("commercial", "get_work_item", { itemId: "w-7001" }, ITEM);

    // The leak: the body must not reach the model.
    expect(content).not.toContain(TICKET_BODY);
    expect(content).not.toContain("Sentinel");
    expect(content).not.toContain("exfil path");
    expect(content).not.toContain(TICKET_TITLE);
    // POSITIVE CONTROL that this is a real, projected result and not an empty or
    // errored one — a blank result would satisfy the assertions above for free.
    expect(content).toContain("42"); // ticketNumber survives the structural projection
    expect(content).not.toContain("error");
  });

  it("2. the DECOY argument: naming an UNCLASSIFIED project in the tool call does not lower the ceiling", async () => {
    setRows([
      { orgId: ORG, projectId: null, level: "UNCLASSIFIED" },
      { orgId: ORG, projectId: HIGH_PROJECT, level: "CUI" },
      { orgId: ORG, projectId: LOW_PROJECT, level: "UNCLASSIFIED" },
    ]);
    // `get_work_item` takes only `itemId`; the executor IGNORES the extra argument
    // and still returns the CUI project's item. Pre-fix the gate computed the
    // ceiling from this decoy and exposed the body.
    const content = await driveRead("commercial", "get_work_item", { itemId: "w-7001", projectId: LOW_PROJECT }, ITEM);

    expect(content).not.toContain(TICKET_BODY);
    expect(content).not.toContain("Sentinel");
    expect(content).toContain("42"); // positive control: a real result was projected
  });

  it("3. the DECOY on a list tool: the ceiling the gate USED is CUI, not the named project's UNCLASSIFIED", async () => {
    setRows([
      { orgId: ORG, projectId: null, level: "UNCLASSIFIED" },
      { orgId: ORG, projectId: HIGH_PROJECT, level: "CUI" },
      { orgId: ORG, projectId: LOW_PROJECT, level: "UNCLASSIFIED" },
    ]);
    // An array-shaped result, so the withheld view is augmented and `mintHandle`
    // is handed the ceiling the gate computed — asserting the VALUE, not just the
    // expose/withhold outcome. (The loop never logs the per-result gate decision
    // itself, so this is the only place that ceiling is observable.)
    const content = await driveRead("commercial", "list_work_items", { projectId: LOW_PROJECT }, ITEM_LIST);

    expect(content).not.toContain(TICKET_TITLE);
    expect(content).toContain("w-7001"); // positive control: the entity's id survives
    expect(mintCeilings()).toEqual(["CUI"]);
  });

  it("4. the ceiling query carries NO project predicate — model input never reaches it", async () => {
    setRows([
      { orgId: ORG, projectId: null, level: "UNCLASSIFIED" },
      { orgId: ORG, projectId: HIGH_PROJECT, level: "CUI" },
    ]);
    await driveRead("commercial", "get_work_item", { itemId: "w-7001", projectId: LOW_PROJECT }, ITEM);

    // POSITIVE CONTROL: the ceiling WAS queried (an unasked query would make the
    // loop below vacuous — it would iterate an empty list).
    const calls = findMany.mock.calls as Array<[{ where: { orgId: string; OR?: Array<{ projectId: string | null }> } }]>;
    expect(calls.length).toBeGreaterThan(0);
    // Every call is scoped to this org, and NONE of them names a project. Note two
    // callers are visible here: the read-path ceiling (conservative, no `OR` at all)
    // and the PROMPT ceiling in egress/index.ts, which is `effectiveCeiling(orgId)`
    // and so asks for the org row with `OR: [{ projectId: null }]`. Neither may carry
    // an id the model supplied.
    for (const [args] of calls) {
      expect(args.where.orgId).toBe(ORG);
      expect((args.where.OR ?? []).filter((c) => c.projectId !== null)).toEqual([]);
    }
    // The discriminating assertion: the read path asked for EVERY row in the org
    // (no project predicate at all). Pre-fix no query had this shape.
    expect(calls.some(([args]) => args.where.OR === undefined)).toBe(true);
    // And no query mentions the project the model named.
    expect(JSON.stringify(findMany.mock.calls)).not.toContain(LOW_PROJECT);
  });

  it("5. gov is unchanged: withheld with and without the CUI project row", async () => {
    // Gov's branch is default-deny for data, so the OUTCOME does not move. (The
    // audit attribution does: `decidedBy` becomes "classification" once the org
    // has a CUI row. The outcome is the invariant, so that is what this asserts.)
    setRows([{ orgId: ORG, projectId: null, level: "UNCLASSIFIED" }]);
    const plain = await driveRead("gov", "get_work_item", { itemId: "w-7001" }, ITEM, "conv-gov-1");
    expect(plain).not.toContain(TICKET_BODY);
    expect(plain).toContain("42");

    callModel.mockReset();
    setRows([
      { orgId: ORG, projectId: null, level: "UNCLASSIFIED" },
      { orgId: ORG, projectId: HIGH_PROJECT, level: "CUI" },
    ]);
    const withCui = await driveRead("gov", "get_work_item", { itemId: "w-7001" }, ITEM, "conv-gov-2");
    expect(withCui).not.toContain(TICKET_BODY);
    expect(withCui).toContain("42");
  });
});

describe("read-path ceiling: an org with NO project-level rows behaves exactly as before", () => {
  it("org=UNCLASSIFIED, commercial ⇒ EXPOSED, the full body reaches the model (the probe CAN see it)", async () => {
    setRows([{ orgId: ORG, projectId: null, level: "UNCLASSIFIED" }]);
    const content = await driveRead("commercial", "get_work_item", { itemId: "w-7001" }, ITEM);

    // The positive control for every "body absent" assertion above, AND the
    // blast-radius bound: nothing changes for an org without project rows.
    expect(content).toContain(TICKET_BODY);
    expect(content).toContain(TICKET_TITLE);
    expect(mintHandle).not.toHaveBeenCalled(); // exposed ⇒ nothing to reference
  });

  it("NO classification rows at all ⇒ the UNCLASSIFIED default, still EXPOSED for commercial", async () => {
    setRows([]);
    const content = await driveRead("commercial", "get_work_item", { itemId: "w-7001" }, ITEM);
    expect(content).toContain(TICKET_BODY);
  });

  it("org=CUI (no project rows), commercial ⇒ WITHHELD at the org ceiling, as before", async () => {
    setRows([{ orgId: ORG, projectId: null, level: "CUI" }]);
    const content = await driveRead("commercial", "get_work_item", { itemId: "w-7001" }, ITEM);
    expect(content).not.toContain(TICKET_BODY);
    expect(content).toContain("42"); // positive control: a real result was projected
  });

  it("org=PUBLIC (no project rows), commercial ⇒ EXPOSED (the org row still decides)", async () => {
    setRows([{ orgId: ORG, projectId: null, level: "PUBLIC" }]);
    const content = await driveRead("commercial", "get_work_item", { itemId: "w-7001" }, ITEM);
    expect(content).toContain(TICKET_BODY);
  });

  it("a list tool on an org with no project rows is EXPOSED and mints nothing (the list probe can see presence too)", async () => {
    setRows([{ orgId: ORG, projectId: null, level: "UNCLASSIFIED" }]);
    const content = await driveRead("commercial", "list_work_items", { projectId: LOW_PROJECT }, ITEM_LIST);
    expect(content).toContain(TICKET_TITLE);
    expect(mintCeilings()).toEqual([]);
  });
});
