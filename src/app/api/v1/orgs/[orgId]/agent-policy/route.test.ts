// @vitest-environment node
//
// RBAC + validation for the TENANT-ADMIN agent-policy route (design D9/§8). Proves:
//   - a caller WITHOUT AGENT_POLICY_MANAGE gets 403 (no DB write);
//   - 401 when there's no auth context;
//   - an AGENT_POLICY_MANAGE admin CAN update the 3 axes (200 + persisted);
//   - an invalid domain ⇒ 400 (no DB write);
//   - the tri-state allowlists map to the stored flag + array shape;
//   - the response never includes OrgMember.permissions (no BigInt).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, logAudit } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    agentPolicy: { findUnique: vi.fn(), upsert: vi.fn() },
  },
  logAudit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));

import { GET, PATCH } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const params = Promise.resolve({ orgId: ORG_ID });

function ctx(perms: bigint): AuthContext {
  return {
    userId: "44444444-4444-4444-4444-444444444444",
    orgId: ORG_ID, orgRole: OrgRole.ADMIN,
    permissions: perms, basePermissions: perms, abacRules: [],
  };
}
function patch(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/agent-policy`, {
    method: "PATCH", body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.agentPolicy.findUnique.mockResolvedValue(null); // permissive default
  prisma.agentPolicy.upsert.mockResolvedValue({ id: "ap-1" });
});

describe("agent-policy — RBAC", () => {
  it("403 for a caller WITHOUT AGENT_POLICY_MANAGE", async () => {
    getAuthContext.mockResolvedValue(ctx(Permission.PROJECT_READ));
    const res = await PATCH(patch({ deniedTools: ["fetch_url"] }), { params });
    expect(res.status).toBe(403);
    expect(prisma.agentPolicy.upsert).not.toHaveBeenCalled();
  });

  it("403 on GET WITHOUT AGENT_POLICY_MANAGE", async () => {
    getAuthContext.mockResolvedValue(ctx(Permission.PROJECT_READ));
    const res = await GET(new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/agent-policy`), { params });
    expect(res.status).toBe(403);
  });

  it("401 when there's no auth context", async () => {
    getAuthContext.mockResolvedValue(null);
    const res = await PATCH(patch({ deniedTools: ["fetch_url"] }), { params });
    expect(res.status).toBe(401);
  });
});

describe("agent-policy — update (with AGENT_POLICY_MANAGE)", () => {
  beforeEach(() => {
    getAuthContext.mockResolvedValue(ctx(Permission.AGENT_POLICY_MANAGE));
  });

  it("updates the 3 axes ⇒ 200 + persisted", async () => {
    const res = await PATCH(
      patch({ deniedDomains: ["finance"], deniedTools: ["fetch_url"], maxResultLimit: 10 }),
      { params },
    );
    expect(res.status).toBe(200);
    const arg = prisma.agentPolicy.upsert.mock.calls[0][0];
    expect(arg.update).toMatchObject({ deniedDomains: ["finance"], deniedTools: ["fetch_url"], maxResultLimit: 10 });
    expect(logAudit).toHaveBeenCalled();
  });

  it("an INVALID domain ⇒ 400, no DB write", async () => {
    const res = await PATCH(patch({ deniedDomains: ["not_a_domain"] }), { params });
    expect(res.status).toBe(400);
    expect(prisma.agentPolicy.upsert).not.toHaveBeenCalled();
  });

  it("maxResultLimit < 1 ⇒ 400", async () => {
    const res = await PATCH(patch({ maxResultLimit: 0 }), { params });
    expect(res.status).toBe(400);
    expect(prisma.agentPolicy.upsert).not.toHaveBeenCalled();
  });

  it("an unknown top-level field ⇒ 400 (.strict)", async () => {
    const res = await PATCH(patch({ tenantClass: "GOV" }), { params });
    expect(res.status).toBe(400);
  });

  it("allowedTools:['query_crm'] ⇒ allowlist ON with that subset", async () => {
    const res = await PATCH(patch({ allowedTools: ["query_crm"] }), { params });
    expect(res.status).toBe(200);
    const arg = prisma.agentPolicy.upsert.mock.calls[0][0];
    expect(arg.update.allowedToolsSet).toBe(true);
    expect(arg.update.allowedTools).toEqual(["query_crm"]);
  });

  it("allowedTools:null ⇒ allowlist OFF (all tools), array cleared", async () => {
    const res = await PATCH(patch({ allowedTools: null }), { params });
    expect(res.status).toBe(200);
    const arg = prisma.agentPolicy.upsert.mock.calls[0][0];
    expect(arg.update.allowedToolsSet).toBe(false);
    expect(arg.update.allowedTools).toEqual([]);
  });

  it("allowedProjectIds:['p1'] ⇒ project allowlist ON with that subset", async () => {
    const res = await PATCH(patch({ allowedProjectIds: ["p1"] }), { params });
    expect(res.status).toBe(200);
    const arg = prisma.agentPolicy.upsert.mock.calls[0][0];
    expect(arg.update.allowedProjectIdsSet).toBe(true);
    expect(arg.update.allowedProjectIds).toEqual(["p1"]);
  });
});

describe("agent-policy — GET", () => {
  it("returns the normalized policy + knownDomains (no permissions/BigInt)", async () => {
    getAuthContext.mockResolvedValue(ctx(Permission.AGENT_POLICY_MANAGE));
    const res = await GET(new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/agent-policy`), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Permissive default (no row): null allowlists, empty deny lists, null cap.
    expect(body).toMatchObject({ allowedTools: null, deniedTools: [], deniedDomains: [], maxResultLimit: null, allowedProjectIds: null });
    expect(Array.isArray(body.knownDomains)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("permissions");
  });
});
