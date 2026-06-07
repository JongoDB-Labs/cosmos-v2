// @vitest-environment node
//
// DOCKER ACCEPTANCE for the Agent-Governance / Egress-Audit dashboard (read-only AC-4/AU-6).
// Runs against the REAL containerized Postgres (docker-compose.acceptance.yml) — the summary
// aggregators (egressSummary/recentDecisions/auditIntegrity), getAgentPolicy, and
// getRuntimeConfig are NOT mocked; they read the DB exactly as in prod. The BEFORE-INSERT
// triggers (seq + row_hash hash-chain) fire on the seeded egress_decisions rows, so
// verify_audit_chain runs over a REAL chain.
//
// Proves, end to end, against the DB:
//   1. seeded VARIED egress_decisions (exposed / classification-withheld / agentpolicy-block /
//      handle_mint / taint_block) for an org's conversation aggregate to the correct totals,
//      withhold rate, and by-decidedBy breakdown.
//   2. recentDecisions returns STRUCTURAL rows — NO contentHash, NO CUI.
//   3. auditIntegrity reports INTACT on the fresh chain + a non-null chain-head high-water mark.
//   4. the route returns 200 with {egress, recent, integrity, posture} for a SECURITY_MANAGE
//      caller; 403 WITHOUT it; and the payload contains NO message content / NO contentHash /
//      NO OrgMember.permissions.
//   5. org scope: a SECOND org's decisions are NOT counted in the first org's aggregates.
//   6. the settings page + dashboard modules import (renders).
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";

// The route reads cookies via getAuthContext — mock ONLY that so we can drive the RBAC path
// against the REAL DB org (everything else hits the container DB for real).
const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext, getCurrentUser: vi.fn() }));

import { prisma } from "@/lib/db/client";
import { egressSummary, recentDecisions, auditIntegrity } from "@/lib/governance/summary";

const ORG_ID = randomUUID();
const OTHER_ORG_ID = randomUUID();
const USER_ID = randomUUID();
const ORG_SLUG = `accept-gov-${randomUUID().slice(0, 8)}`;
const OTHER_SLUG = `accept-gov2-${randomUUID().slice(0, 8)}`;
const CONVO_ID = randomUUID(); // an AssistantConversation id — the egress-decision scope
const OTHER_CONVO_ID = randomUUID();

// A varied set of egress decisions for ORG_ID's conversation. contentHash is a FAKE sha-like
// hex string (NOT derived from any CUI — there is no CUI here); it exists only to satisfy the
// NOT NULL column and to prove the read model never surfaces it.
const SEED = [
  { decidedBy: "none", exposed: true, withheldCount: 0, ceiling: "PUBLIC", toolName: "list_projects" },
  { decidedBy: "classification", exposed: false, withheldCount: 2, ceiling: "CUI", toolName: "search_work_items" },
  { decidedBy: "agentpolicy", exposed: false, withheldCount: 1, ceiling: null, toolName: "query_finance" },
  { decidedBy: "handle_mint", exposed: true, withheldCount: 1, ceiling: "CUI", toolName: "get_work_item" },
  { decidedBy: "handle_taint_block", exposed: false, withheldCount: 1, ceiling: "CUI", toolName: "update_work_item" },
];

beforeAll(async () => {
  for (const [id, slug] of [[ORG_ID, ORG_SLUG], [OTHER_ORG_ID, OTHER_SLUG]] as const) {
    await prisma.organization.create({ data: { id, name: `accept ${id}`, slug, tenantClass: "GOV" } });
  }
  // A user (FK target for the conversation) + the conversations that scope the decisions.
  await prisma.user.create({
    data: { id: USER_ID, email: `${ORG_SLUG}@example.com`, displayName: "Acceptance" },
  });
  await prisma.assistantConversation.create({ data: { id: CONVO_ID, orgId: ORG_ID, userId: USER_ID } });
  await prisma.assistantConversation.create({ data: { id: OTHER_CONVO_ID, orgId: OTHER_ORG_ID, userId: USER_ID } });

  // An AgentPolicy + RuntimeConfig so the posture has real (non-default) content to surface.
  await prisma.agentPolicy.create({
    data: { orgId: ORG_ID, deniedTools: ["fetch_url"], deniedDomains: ["finance"], maxResultLimit: 25 },
  });
  await prisma.orgRuntimeConfig.create({
    data: { orgId: ORG_ID, allowlistEnabled: true, enabledConnectors: ["github"], breadthEnabled: false, mcpEnabled: false },
  });

  // Seed the varied egress decisions for ORG_ID's conversation (triggers fill seq + row_hash).
  let turn = 0;
  for (const s of SEED) {
    await prisma.egressDecisionRow.create({
      data: {
        conversationId: CONVO_ID,
        turn: turn++,
        valueKind: "tool_result",
        toolName: s.toolName,
        exposed: s.exposed,
        withheldCount: s.withheldCount,
        contentHash: "deadbeef".repeat(8), // fake hex; NOT from any CUI
        decidedBy: s.decidedBy,
        tenantClass: "GOV",
        ceiling: s.ceiling,
      },
    });
  }
  // One decision for the OTHER org — must NOT count in ORG_ID's aggregates (org-scope proof).
  await prisma.egressDecisionRow.create({
    data: {
      conversationId: OTHER_CONVO_ID, turn: 0, valueKind: "tool_result", toolName: "list_projects",
      exposed: true, withheldCount: 0, contentHash: "cafebabe".repeat(8), decidedBy: "none",
      tenantClass: "GOV", ceiling: "PUBLIC",
    },
  });
});

afterAll(async () => {
  // NOTE: egress_decisions is APPEND-ONLY for cosmos_app (AU-9: REVOKE DELETE + the
  // immutability trigger), so we DO NOT (and CANNOT) delete the seeded decision rows — they
  // are harmless metadata in the throwaway acceptance DB and proving they can't be deleted is
  // itself part of the audit posture. The conversations are kept too (deleting them would
  // cascade-orphan nothing useful and egress rows are FK-decoupled). We clean up the rest.
  await prisma.agentPolicy.deleteMany({ where: { orgId: ORG_ID } }).catch(() => {});
  await prisma.orgRuntimeConfig.deleteMany({ where: { orgId: ORG_ID } }).catch(() => {});
  await prisma.$disconnect();
});

describe("ACCEPTANCE: egress aggregation (real DB)", () => {
  it("1. aggregates the seeded decisions — totals, withhold rate, by-decidedBy", async () => {
    const s = await egressSummary(ORG_ID);
    expect(s.total).toBe(5);
    expect(s.exposed).toBe(2); // none + handle_mint
    expect(s.withheld).toBe(3); // classification + agentpolicy + handle_taint_block
    expect(s.withholdRate).toBeCloseTo(0.6, 5);
    expect(s.byDecidedBy.none).toBe(1);
    expect(s.byDecidedBy.classification).toBe(1);
    expect(s.byDecidedBy.agentpolicy).toBe(1);
    expect(s.byDecidedBy.handle_mint).toBe(1);
    expect(s.byDecidedBy.handle_taint_block).toBe(1);
    expect(s.byCeiling).toMatchObject({ PUBLIC: 1, CUI: 3, "(none)": 1 });
    expect(s.byTenantClass).toEqual({ GOV: 5 });
  });

  it("5. org scope — the OTHER org's decision is NOT counted", async () => {
    const s = await egressSummary(ORG_ID);
    // ORG_ID has exactly 5 (its own); the other org's extra decision is excluded.
    expect(s.total).toBe(5);
    const other = await egressSummary(OTHER_ORG_ID);
    expect(other.total).toBe(1);
  });
});

describe("ACCEPTANCE: recentDecisions — structural, NO CUI (real DB)", () => {
  it("2. returns structural rows with NO contentHash / NO content", async () => {
    const rows = await recentDecisions(ORG_ID, 10);
    expect(rows.length).toBe(5);
    for (const r of rows) {
      expect(r).not.toHaveProperty("contentHash");
      expect(typeof r.seq === "string" || r.seq === null).toBe(true);
    }
    const text = JSON.stringify(rows);
    expect(text).not.toContain("contentHash");
    expect(text).not.toContain("deadbeef"); // the seeded hash never leaks
  });
});

describe("ACCEPTANCE: auditIntegrity — fresh chain (real DB)", () => {
  it("3. reports INTACT for both chains + a non-null egress chain-head", async () => {
    const i = await auditIntegrity();
    expect(i.auditLogs).toBe("intact");
    expect(i.egressDecisions).toBe("intact");
    expect(i.auditLogsReason).toBeNull();
    expect(i.egressDecisionsReason).toBeNull();
    // The seeded rows advanced the egress chain head — high-water mark is present.
    expect(i.latestWormToSeq).not.toBeNull();
    expect(Number(i.latestWormToSeq)).toBeGreaterThanOrEqual(5);
  });
});

describe("ACCEPTANCE: governance route RBAC + shape + no-leak + page (real DB)", () => {
  function authCtx(perms: bigint) {
    return { userId: USER_ID, orgId: ORG_ID, orgRole: OrgRole.ADMIN, permissions: perms, basePermissions: perms, abacRules: [] };
  }
  function getReq() {
    return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/agent-governance`);
  }
  const params = Promise.resolve({ orgId: ORG_ID });

  it("4a. GET 403s a caller WITHOUT SECURITY_MANAGE", async () => {
    const { Permission } = await import("@/lib/rbac/permissions");
    const { GET } = await import("@/app/api/v1/orgs/[orgId]/agent-governance/route");
    getAuthContext.mockReset().mockResolvedValue(authCtx(Permission.PROJECT_READ));
    const res = await GET(getReq(), { params });
    expect(res.status).toBe(403);
  });

  it("4b. GET 200 + {egress, recent, integrity, posture}; NO contentHash / NO permissions", async () => {
    const { Permission } = await import("@/lib/rbac/permissions");
    const { GET } = await import("@/app/api/v1/orgs/[orgId]/agent-governance/route");
    getAuthContext.mockReset().mockResolvedValue(authCtx(Permission.SECURITY_MANAGE));
    const res = await GET(getReq(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Aggregates
    expect(body.egress.total).toBe(5);
    expect(body.egress.withholdRate).toBeCloseTo(0.6, 5);
    expect(body.egress.byDecidedBy.classification).toBe(1);
    // Recent structural rows
    expect(Array.isArray(body.recent)).toBe(true);
    expect(body.recent.length).toBe(5);
    // Integrity
    expect(body.integrity.auditLogs).toBe("intact");
    expect(body.integrity.egressDecisions).toBe("intact");
    // Posture
    expect(body.posture.tenantClass).toBe("GOV");
    expect(body.posture.agentPolicy.deniedTools).toContain("fetch_url");
    expect(body.posture.agentPolicy.deniedDomains).toContain("finance");
    expect(body.posture.agentPolicy.maxResultLimit).toBe(25);
    expect(body.posture.runtimeConfig.enabledConnectors).toEqual(["github"]);
    expect(body.posture.runtimeConfig.breadthEnabled).toBe(false);

    // NO message content / NO contentHash / NO OrgMember.permissions in the payload.
    const text = JSON.stringify(body);
    expect(text).not.toContain("contentHash");
    expect(text).not.toContain("deadbeef");
    expect(text).not.toContain("permissions");
  });

  it("6. the settings page + dashboard modules import (renders)", async () => {
    const page = await import("@/app/(dashboard)/[orgSlug]/settings/agent-governance/page");
    const dash = await import("@/components/settings/agent-governance-dashboard");
    expect(typeof page.default).toBe("function");
    expect(typeof dash.AgentGovernanceDashboard).toBe("function");
  });
});
