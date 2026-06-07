// @vitest-environment node
//
// RBAC + SHAPE for the READ-ONLY agent-governance route. Proves:
//   - a caller WITHOUT SECURITY_MANAGE gets 403 (no data leaks);
//   - 401 with no auth context; 404 for an unknown org;
//   - with the perm ⇒ 200 + the {egress, recent, integrity, posture} shape;
//   - NO contentHash / NO OrgMember.permissions (BigInt) in the payload.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, egressSummary, recentDecisions, auditIntegrity, getAgentPolicy, getRuntimeConfig } =
  vi.hoisted(() => ({
    getAuthContext: vi.fn(),
    prisma: { organization: { findUnique: vi.fn() } },
    egressSummary: vi.fn(),
    recentDecisions: vi.fn(),
    auditIntegrity: vi.fn(),
    getAgentPolicy: vi.fn(),
    getRuntimeConfig: vi.fn(),
  }));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/governance/summary", () => ({ egressSummary, recentDecisions, auditIntegrity }));
vi.mock("@/lib/ai/policy", () => ({ getAgentPolicy }));
vi.mock("@/lib/runtime-config", () => ({ getRuntimeConfig }));

import { GET } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const params = Promise.resolve({ orgId: ORG_ID });

function ctx(perms: bigint): AuthContext {
  return {
    userId: "44444444-4444-4444-4444-444444444444",
    orgId: ORG_ID,
    orgRole: OrgRole.ADMIN,
    permissions: perms,
    basePermissions: perms,
    abacRules: [],
  };
}
function req(qs = "") {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/agent-governance${qs}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme", tenantClass: "GOV" });
  egressSummary.mockResolvedValue({
    total: 4,
    exposed: 2,
    withheld: 2,
    withholdRate: 0.5,
    byDecidedBy: { classification: 1, agentpolicy: 1, handle_mint: 1, none: 1 },
    byCeiling: { CUI: 2, PUBLIC: 1, "(none)": 1 },
    byTenantClass: { GOV: 4 },
  });
  recentDecisions.mockResolvedValue([
    {
      seq: "42",
      createdAt: "2026-06-07T12:00:00.000Z",
      toolName: "search_work_items",
      decidedBy: "classification",
      exposed: false,
      withheldCount: 3,
      ceiling: "CUI",
      tenantClass: "GOV",
    },
  ]);
  auditIntegrity.mockResolvedValue({
    auditLogs: "intact",
    auditLogsReason: null,
    egressDecisions: "intact",
    egressDecisionsReason: null,
    latestWormToSeq: "7",
    latestCheckpointSeq: null,
  });
  getAgentPolicy.mockResolvedValue({
    allowedTools: null,
    deniedTools: ["send_email"],
    deniedDomains: ["external_comms"],
    maxResultLimit: 50,
    allowedProjectIds: null,
  });
  getRuntimeConfig.mockResolvedValue({ enabledConnectors: ["github"], breadthEnabled: false, mcpEnabled: false });
});

describe("agent-governance — RBAC", () => {
  it("403 for a caller WITHOUT SECURITY_MANAGE (no data leaks)", async () => {
    getAuthContext.mockResolvedValue(ctx(Permission.PROJECT_READ));
    const res = await GET(req(), { params });
    expect(res.status).toBe(403);
    expect(egressSummary).not.toHaveBeenCalled();
    expect(recentDecisions).not.toHaveBeenCalled();
  });

  it("401 when there's no auth context", async () => {
    getAuthContext.mockResolvedValue(null);
    const res = await GET(req(), { params });
    expect(res.status).toBe(401);
  });

  it("404 for an unknown org", async () => {
    prisma.organization.findUnique.mockResolvedValue(null);
    getAuthContext.mockResolvedValue(ctx(Permission.SECURITY_MANAGE));
    const res = await GET(req(), { params });
    expect(res.status).toBe(404);
  });
});

describe("agent-governance — GET (with perm)", () => {
  beforeEach(() => getAuthContext.mockResolvedValue(ctx(Permission.SECURITY_MANAGE)));

  it("200 + the {egress, recent, integrity, posture} shape", async () => {
    const res = await GET(req(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.egress.withholdRate).toBe(0.5);
    expect(body.egress.byDecidedBy.classification).toBe(1);
    expect(Array.isArray(body.recent)).toBe(true);
    expect(body.recent[0].toolName).toBe("search_work_items");
    expect(body.integrity.auditLogs).toBe("intact");
    expect(body.integrity.egressDecisions).toBe("intact");
    expect(body.integrity.latestWormToSeq).toBe("7");
    expect(body.posture.tenantClass).toBe("GOV");
    expect(body.posture.agentPolicy.deniedTools).toContain("send_email");
    expect(body.posture.runtimeConfig.breadthEnabled).toBe(false);
  });

  it("never surfaces contentHash or OrgMember.permissions (no BigInt)", async () => {
    const res = await GET(req(), { params });
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("contentHash");
    expect(text).not.toContain("permissions");
  });

  it("passes a valid `since` through to the aggregator", async () => {
    await GET(req("?since=2026-06-01T00:00:00Z"), { params });
    const sinceArg = egressSummary.mock.calls[0][1] as Date;
    expect(sinceArg).toBeInstanceOf(Date);
    expect(sinceArg.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("ignores an invalid `since` (treats as all-time)", async () => {
    await GET(req("?since=not-a-date"), { params });
    expect(egressSummary.mock.calls[0][1]).toBeUndefined();
  });
});
