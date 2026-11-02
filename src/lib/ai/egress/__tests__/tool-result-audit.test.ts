// @vitest-environment node
//
// EVERY tool result the gate judges gets an evidence row.
//
// `EgressDecision` is documented as "Logged for EVERY value the gate processes", and
// `projectForModel` is a PURE function — it returns a decision and logs nothing. So the
// obligation falls on each call site, and they are easy to miss one at a time:
// `runModelTurn` logs the system prompt and each message body, the connector registry logs
// its four denial events, the handle resolver logs mint/resolve/taint — and the tool_result
// call site in the agent loop logged nothing at all. That was the highest-volume flow in
// the system and the only one carrying database rows OUTWARD to the model.
//
// These specs assert on the AUDIT ROW, not on a spy being called, and they identify the
// gate's own row by its CONTENT HASH: the gate hashes the SOURCE value it judged, while the
// `handle_mint` row for the same tool hashes the withheld structural view instead. Matching
// on the hash therefore cannot be satisfied by the mint row, which is what made the hole
// invisible to a looser assertion in the first place.
//
// The gate runs FOR REAL here; only its DB and model edges are doubled.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { stubAuth } from "@/lib/testing/tool-auth";
import { Permission } from "@/lib/rbac/permissions";
import { sha256Hex } from "@/lib/ai/egress/gate";
import type { EgressDecision } from "@/lib/ai/egress/types";

const {
  callModel, executeTool, logEgressDecision, classifyLikelyCui,
  getAgentPolicy, getReadableProjectIds, getVisibleProjectIds, classificationFindMany,
} = vi.hoisted(() => ({
  callModel: vi.fn(),
  executeTool: vi.fn(),
  logEgressDecision: vi.fn(),
  classifyLikelyCui: vi.fn().mockResolvedValue(false),
  getAgentPolicy: vi.fn(),
  getReadableProjectIds: vi.fn(),
  getVisibleProjectIds: vi.fn(),
  classificationFindMany: vi.fn(),
}));

vi.mock("@/lib/ai/egress/provider", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callModel,
}));
vi.mock("@/lib/ai/tool-executor", () => ({ executeTool }));
vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: vi.fn().mockResolvedValue({ enabledConnectors: null, breadthEnabled: true, mcpEnabled: false }),
}));
vi.mock("@/lib/ai/policy", () => ({ getAgentPolicy }));
vi.mock("@/lib/ai/egress/audit", () => ({ logEgressDecision }));
vi.mock("@/lib/classification/classifier", () => ({ classifyLikelyCui }));
vi.mock("@/lib/ai/ai-credentials", () => ({ resolveOrgModelCredential: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/ai/egress/handles", () => ({
  mintHandle: vi.fn(async () => "h:AUDITROWTOKEN00000000000"),
  resolveHandle: vi.fn(async () => null),
  resolveHandlesDeep: vi.fn(async (input: unknown) => ({ resolved: input, count: 0, maxCeiling: null })),
  isHandle: () => false,
}));
// The roster resolves to NOTHING on purpose: an empty roster emits no row of its own, so
// every tool_result row these specs see came from the tool-result path under test.
vi.mock("@/lib/work-items/query/scope", () => ({ getReadableProjectIds }));
vi.mock("@/lib/rbac/project-access", () => ({ getVisibleProjectIds }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    project: { findMany: vi.fn(async () => []) },
    dataClassification: { findMany: classificationFindMany },
  },
  prismaUnfiltered: { project: { findMany: vi.fn(async () => []) } },
}));

const ORG = "org-auditrow";
const ME = "u-auditrow";

const ITEM = { id: "w-1", title: "a ticket", projectId: "p-1" };

type TenantClass = "commercial" | "gov";

/** Drive one tool turn + an end turn. */
async function drive(opts: {
  tenantClass: TenantClass;
  toolUses?: { id: string; name: string; input: Record<string, unknown> }[];
  outputFor?: (name: string) => unknown;
}): Promise<void> {
  const uses = opts.toolUses ?? [{ id: "t1", name: "get_work_item", input: { itemId: "w-1" } }];
  getAgentPolicy.mockResolvedValue({
    allowedTools: null, deniedTools: [], deniedDomains: [],
    maxResultLimit: null, allowedProjectIds: null,
  });
  callModel
    .mockResolvedValueOnce({ text: "", toolUses: uses, stopReason: "tool_use" })
    .mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });
  executeTool.mockImplementation(async (name: string) =>
    opts.outputFor ? opts.outputFor(name) : ITEM,
  );

  const { runAgentLoop } = await import("@/lib/ai/agent-loop");
  await runAgentLoop({
    orgId: ORG,
    userId: ME,
    auth: stubAuth(ORG, ME, { orgRole: "OWNER", permissions: Permission.ITEM_READ }),
    tenantClass: opts.tenantClass,
    conversationId: "conv-auditrow",
    systemPrompt: "you are cosmos",
    initialPrompt: "read that ticket",
  });
}

const allRows = (): EgressDecision[] =>
  logEgressDecision.mock.calls.map((c) => c[0] as EgressDecision);

/**
 * The GATE's own verdict row for `output`, as distinct from the `handle_mint` event row for
 * the same tool: the gate hashes the SOURCE value, the mint row hashes the withheld
 * structural view. So the hash — not the tool name — is what pins this to the gate.
 */
const gateRowFor = (output: unknown): EgressDecision | undefined =>
  allRows().find((d) => d.valueKind === "tool_result" && d.contentHash === sha256Hex(output));

beforeEach(() => {
  vi.clearAllMocks();
  callModel.mockReset();
  executeTool.mockReset();
  getReadableProjectIds.mockResolvedValue([]);
  getVisibleProjectIds.mockResolvedValue(new Set<string>());
  classificationFindMany.mockResolvedValue([]); // no rows ⇒ ceiling UNCLASSIFIED
});

describe("tool_result egress decisions are audited", () => {
  it("CONTROL: the audit sink is wired — the system prompt already produced a row", async () => {
    // Guards the guard. Without this, a spec that asserted only the ABSENCE of something
    // would pass just as well against a `logEgressDecision` that is never called at all.
    await drive({ tenantClass: "commercial" });
    expect(allRows().some((d) => d.valueKind === "system")).toBe(true);
  });

  it("records an EXPOSED tool result", async () => {
    await drive({ tenantClass: "commercial" });

    const row = gateRowFor(ITEM);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      conversationId: "conv-auditrow",
      valueKind: "tool_result",
      toolName: "get_work_item",
      exposed: true,
      withheldCount: 0,
      decidedBy: "none",
      tenantClass: "commercial",
      ceiling: "UNCLASSIFIED",
    });
  });

  it("records a WITHHELD tool result — the case that previously logged nothing", async () => {
    // A gov tenant at the default ceiling is a fail-closed withhold (`decidedBy: "tenant"`).
    // Before this shipped, the withheld path emitted a row ONLY when handle minting happened
    // to fire, so a withhold that minted nothing left no trace of having been withheld.
    await drive({ tenantClass: "gov" });

    const row = gateRowFor(ITEM);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      valueKind: "tool_result",
      toolName: "get_work_item",
      exposed: false,
      withheldCount: 1,
      decidedBy: "tenant",
      tenantClass: "gov",
    });
  });

  it("records the CEILING that drove a classification withhold", async () => {
    // The ceiling is the evidence that matters on review: "withheld" without it does not
    // say whether the gate was enforcing a marking or just defaulting closed.
    classificationFindMany.mockResolvedValue([{ level: "CUI", projectId: null }]);
    await drive({ tenantClass: "commercial" });

    expect(gateRowFor(ITEM)).toMatchObject({
      exposed: false,
      decidedBy: "classification",
      ceiling: "CUI",
    });
  });

  it("records ONE row per tool result, not one per turn", async () => {
    const OTHER = { id: "p-9", name: "Apollo", archived: false };
    await drive({
      tenantClass: "commercial",
      toolUses: [
        { id: "t1", name: "get_work_item", input: { itemId: "w-1" } },
        { id: "t2", name: "list_projects", input: {} },
      ],
      outputFor: (name) => (name === "get_work_item" ? ITEM : OTHER),
    });

    // Two results, two gate rows, each naming its own tool — a per-turn row would collapse
    // these into one and lose which tool the verdict was about.
    expect(gateRowFor(ITEM)?.toolName).toBe("get_work_item");
    expect(gateRowFor(OTHER)?.toolName).toBe("list_projects");
    expect(allRows().filter((d) => d.valueKind === "tool_result")).toHaveLength(2);
  });

  it("hashes the SOURCE value, so the row is tamper-evidence for what the gate judged", async () => {
    await drive({ tenantClass: "commercial" });

    const row = gateRowFor(ITEM)!;
    expect(row.contentHash).toBe(sha256Hex(ITEM));
    // Not the hash of some other serialization of the same data — this pins the exact
    // bytes, which is the whole point of carrying a hash rather than a flag.
    expect(row.contentHash).not.toBe(sha256Hex({ ...ITEM, title: "something else" }));
  });
});
