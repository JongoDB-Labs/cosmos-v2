// @vitest-environment node
//
// LOOP WIRING for the agent-policy project allowlist and the project roster.
//
// `project-scope.test.ts` proves `narrowAuthToPolicyProjects` intersects correctly and
// `project-roster.test.ts` proves the roster withholds names when it must — but both test
// FUNCTIONS. Neither can tell whether `runAgentLoop` actually calls them, and a correct
// helper with no call site is this repo's most-repeated defect shape (see
// "a pure rule only runs where someone calls it"). So these specs drive the real loop and
// assert on what crossed its two boundaries:
//
//   1. the `auth` handed to `executeTool`  — does the allowlist ride the context?
//   2. the `system` handed to the model    — does the roster reach the prompt?
//
// A spec that mocked `narrowAuthToPolicyProjects` or `projectRosterBlock` could only assert
// that a spy was called, so both run FOR REAL here; only their DB and model edges are
// doubled.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { stubAuth } from "@/lib/testing/tool-auth";
import { Permission } from "@/lib/rbac/permissions";

const {
  callModel, executeTool, logEgressDecision, classifyLikelyCui,
  getAgentPolicy, getReadableProjectIds, getVisibleProjectIds, projectFindMany,
} = vi.hoisted(() => ({
  callModel: vi.fn(),
  executeTool: vi.fn(),
  logEgressDecision: vi.fn(),
  classifyLikelyCui: vi.fn().mockResolvedValue(false),
  getAgentPolicy: vi.fn(),
  getReadableProjectIds: vi.fn(),
  getVisibleProjectIds: vi.fn(),
  projectFindMany: vi.fn(),
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
  mintHandle: vi.fn(async () => "h:LOOPSCOPETOKEN0000000000"),
  resolveHandle: vi.fn(async () => null),
  resolveHandlesDeep: vi.fn(async (input: unknown) => ({ resolved: input, count: 0, maxCeiling: null })),
  isHandle: () => false,
}));
// The roster's own edges. The SCOPE helpers are doubled rather than the roster, so the
// roster's gating logic runs for real.
vi.mock("@/lib/work-items/query/scope", () => ({ getReadableProjectIds }));
vi.mock("@/lib/rbac/project-access", () => ({ getVisibleProjectIds }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    project: { findMany: projectFindMany },
    // The read-path ceiling query: no rows ⇒ the org's ceiling is the default, so the
    // roster is EXPOSED and its names are assertable. The withheld case is covered in
    // project-roster.test.ts.
    dataClassification: { findMany: vi.fn(async () => []) },
  },
  prismaUnfiltered: { project: { findMany: projectFindMany } },
}));

const ORG = "org-loopscope";
const ME = "u-loopscope";
const ALLOWED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXCLUDED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const POLICY = (allowedProjectIds: string[] | null) => ({
  allowedTools: null, deniedTools: [], deniedDomains: [],
  maxResultLimit: null, allowedProjectIds,
});

/** Drive one tool turn + an end turn. Returns the `system` the LAST model call received. */
async function drive(allowlist: string[] | null, incomingScope?: string[]): Promise<string> {
  getAgentPolicy.mockResolvedValue(POLICY(allowlist));
  callModel
    .mockResolvedValueOnce({ text: "", toolUses: [{ id: "t1", name: "get_work_item", input: { itemId: "w-1" } }], stopReason: "tool_use" })
    .mockResolvedValueOnce({ text: "done", toolUses: [], stopReason: "end_turn" });
  executeTool.mockResolvedValue({ id: "w-1", title: "a ticket", projectId: ALLOWED });

  const { runAgentLoop } = await import("@/lib/ai/agent-loop");
  await runAgentLoop({
    orgId: ORG,
    userId: ME,
    auth: stubAuth(ORG, ME, {
      orgRole: "OWNER",
      permissions: Permission.ITEM_READ,
      ...(incomingScope ? { projectScope: incomingScope, isApiKey: true } : {}),
    }),
    tenantClass: "commercial",
    conversationId: "conv-loopscope",
    systemPrompt: "you are cosmos",
    initialPrompt: "read that ticket",
  });

  return String(callModel.mock.calls.at(-1)?.[0]?.system ?? "");
}

/** The projectScope the executor was actually authorised with. */
const scopeAtExecutor = (): readonly string[] | undefined =>
  executeTool.mock.calls[0]?.[2]?.auth?.projectScope;

beforeEach(() => {
  vi.clearAllMocks();
  callModel.mockReset();
  getReadableProjectIds.mockResolvedValue([ALLOWED, EXCLUDED]);
  getVisibleProjectIds.mockImplementation(async (_auth: unknown, ids: string[]) => new Set(ids));
  projectFindMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
    [
      { id: ALLOWED, key: "APL", name: "Apollo Ground Segment", archivedAt: null },
      { id: EXCLUDED, key: "BCN", name: "Beacon Telemetry", archivedAt: null },
    ].filter((p) => args.where.id.in.includes(p.id)),
  );
});

describe("agent loop — the allowlist rides the context", () => {
  it("hands executeTool an auth narrowed to the allowlist", async () => {
    await drive([ALLOWED]);
    expect(scopeAtExecutor()).toEqual([ALLOWED]);
  });

  it("leaves the context untouched when no allowlist is set", async () => {
    await drive(null);
    // Not `[]`, and not the org's projects — UNDEFINED, i.e. unrestricted, exactly as
    // before this shipped. An org that never opted in must see no change.
    expect(scopeAtExecutor()).toBeUndefined();
  });

  it("INTERSECTS with an API key's own scope rather than replacing it", async () => {
    // The key reaches BOTH, the policy allows ONE. Deliberately asymmetric: with the
    // incoming scope already equal to the answer, this spec would pass even if the loop
    // never narrowed at all — which is how it read before mutation testing showed it
    // surviving `auth: opts.auth`.
    await drive([EXCLUDED], [ALLOWED, EXCLUDED]);
    expect(scopeAtExecutor()).toEqual([EXCLUDED]);
    expect(scopeAtExecutor()).not.toContain(ALLOWED);
  });
});

describe("agent loop — the roster reaches the model", () => {
  it("appends the caller's projects to the system prompt", async () => {
    const system = await drive(null);
    expect(system).toContain("you are cosmos"); // the caller's prompt is preserved
    expect(system).toContain("Apollo Ground Segment");
    expect(system).toContain("Beacon Telemetry");
    expect(system).toContain("2 projects");
  });

  it("lists ONLY projects inside the allowlist — what it is told cannot exceed what it can reach", async () => {
    // The narrowed auth is what the roster resolves from, so the excluded project must not
    // appear. If the roster were built from orgId instead, it would advertise a project the
    // tools then refuse — and leak its name while doing it.
    getReadableProjectIds.mockImplementation(async (auth: { projectScope?: readonly string[] }) => {
      const all = [ALLOWED, EXCLUDED];
      return auth.projectScope ? all.filter((id) => auth.projectScope!.includes(id)) : all;
    });

    const system = await drive([ALLOWED]);
    expect(system).toContain("Apollo Ground Segment");
    expect(system).not.toContain("Beacon Telemetry");
    expect(system).toContain("1 project");
  });

  it("still runs when the roster cannot be built", async () => {
    // Best-effort: a roster failure costs a discovery round-trip, never the turn. It also
    // never widens access — every gate below still enforces the narrowed auth itself.
    getReadableProjectIds.mockRejectedValue(new Error("db down"));
    const system = await drive([ALLOWED]);
    expect(system).toBe("you are cosmos");
    expect(scopeAtExecutor()).toEqual([ALLOWED]);
  });
});
