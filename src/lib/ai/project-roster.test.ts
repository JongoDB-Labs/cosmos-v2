// @vitest-environment node
//
// The project roster is a NAME CHANNEL, so the specs that matter are the ones about what it
// refuses to say.
//
// `EXPOSABLE_FIELDS.project` is `["id", "archived", "createdAt", "updatedAt"]` — a project's
// `name` and `key` are deliberately not exposable, and `list_projects` already returns ids
// with the names withheld. A roster injected into the system prompt would bypass that
// entirely if it were gated as `valueKind: "system"` (the gate treats prompts as non-data
// and exposes them unconditionally), so these specs pin the gov/withheld case hardest.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Permission } from "@/lib/rbac/permissions";

const { prisma, getReadableProjectIds, getVisibleProjectIds, logEgressDecision } = vi.hoisted(() => ({
  prisma: { project: { findMany: vi.fn() } },
  getReadableProjectIds: vi.fn(),
  getVisibleProjectIds: vi.fn(),
  logEgressDecision: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma, prismaUnfiltered: prisma }));
vi.mock("@/lib/work-items/query/scope", () => ({ getReadableProjectIds }));
vi.mock("@/lib/rbac/project-access", () => ({ getVisibleProjectIds }));
vi.mock("@/lib/ai/egress/audit", () => ({ logEgressDecision }));

import { projectRosterBlock } from "./project-roster";
import { stubAuth } from "@/lib/testing/tool-auth";

const ORG = "org-1";
const ME = "11111111-1111-4111-a111-111111111111";
const P1 = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

const auth = stubAuth(ORG, ME, { orgRole: "MEMBER", permissions: Permission.ITEM_READ });

const ROWS = [
  { id: P1, key: "APL", name: "Apollo Ground Segment", archivedAt: null },
  { id: P2, key: "BCN", name: "Beacon Telemetry", archivedAt: new Date("2026-01-01") },
];

const block = (over: Partial<Parameters<typeof projectRosterBlock>[0]> = {}) =>
  projectRosterBlock({
    auth, orgId: ORG, tenantClass: "commercial", conversationId: "conv-1",
    ceiling: "UNCLASSIFIED", ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  getReadableProjectIds.mockResolvedValue([P1, P2]);
  getVisibleProjectIds.mockResolvedValue(new Set([P1, P2]));
  prisma.project.findMany.mockResolvedValue(ROWS);
});

describe("projectRosterBlock — what it tells the model", () => {
  it("gives a commercial tenant below the ceiling the names, keys and ids", async () => {
    const out = await block();
    expect(out).toContain("Apollo Ground Segment");
    expect(out).toContain("APL");
    expect(out).toContain(P1);
    expect(out).toContain("2 projects");
    // An archived project is labelled rather than hidden — the model should know it exists
    // and that it is closed, or it will keep proposing work in it.
    expect(out).toContain("[archived]");
  });

  it("WITHHOLDS names and keys from a gov tenant, giving ids only", async () => {
    const out = await block({ tenantClass: "gov" });
    expect(out).not.toContain("Apollo Ground Segment");
    expect(out).not.toContain("Beacon Telemetry");
    expect(out).not.toContain("APL");
    expect(out).not.toContain("BCN");
    // Still useful: the model can scope its calls and knows how many it may touch.
    expect(out).toContain(P1);
    expect(out).toContain(P2);
    expect(out).toContain("withheld");
  });

  it("WITHHOLDS names at or above FOUO even for a commercial tenant", async () => {
    for (const ceiling of ["FOUO", "CUI", "CONFIDENTIAL"] as const) {
      const out = await block({ ceiling });
      expect(out, ceiling).not.toContain("Apollo Ground Segment");
      expect(out, ceiling).toContain(P1);
    }
  });

  it("audits the decision, so the roster is not a silent injection", async () => {
    await block({ tenantClass: "gov" });
    expect(logEgressDecision).toHaveBeenCalledTimes(1);
    const d = logEgressDecision.mock.calls[0][0];
    expect(d.exposed).toBe(false);
    expect(d.valueKind).toBe("tool_result");
    expect(d.toolName).toBe("list_projects");
  });

  it("returns null when the actor can read no projects", async () => {
    getReadableProjectIds.mockResolvedValue([]);
    expect(await block()).toBeNull();
    // Never queried: nothing to ask about.
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it("returns null when the projects are readable but not VISIBLE (the GUEST case)", async () => {
    // A GUEST holds ITEM_READ without PROJECT_READ, so getVisibleProjectIds is empty. A
    // roster is project metadata, so it takes the narrower of the two and says nothing.
    getVisibleProjectIds.mockResolvedValue(new Set());
    expect(await block()).toBeNull();
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it("resolves the roster from the AuthContext it was handed, so a narrowed scope binds", async () => {
    // The loop passes the POLICY-NARROWED auth. If the roster resolved from orgId instead,
    // it would advertise projects the tools then refuse — and leak their names doing it.
    const narrowed = stubAuth(ORG, ME, {
      orgRole: "OWNER", permissions: Permission.ITEM_READ, projectScope: [P1],
    });
    await block({ auth: narrowed });
    expect(getReadableProjectIds).toHaveBeenCalledWith(narrowed);
    expect(getVisibleProjectIds.mock.calls[0][0]).toBe(narrowed);
  });

  it("scopes the name query to the org and the visible set", async () => {
    await block();
    const arg = prisma.project.findMany.mock.calls[0][0];
    expect(arg.where.orgId).toBe(ORG);
    expect([...arg.where.id.in].sort()).toEqual([P1, P2].sort());
  });
});
