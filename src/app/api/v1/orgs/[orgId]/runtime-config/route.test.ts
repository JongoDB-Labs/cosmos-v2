// @vitest-environment node
//
// RBAC + GOV GUARDRAIL for the TENANT-ADMIN runtime-config route. Proves:
//   - a non-admin (no INTEGRATION_MANAGE) gets 403;
//   - a GOV org's PATCH enabling breadth (or mcp, or a commercial-only connector) is
//     REJECTED 400 server-side — a tenant-admin can't lift the gov guardrails;
//   - a COMMERCIAL org CAN toggle breadth;
//   - tenantClass is never writable here (the schema is .strict()).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";
import "@/lib/ai/connectors"; // register real descriptors so nango = commercial-only

const { getAuthContext, prisma, logAudit } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    orgRuntimeConfig: { findUnique: vi.fn(), upsert: vi.fn() },
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
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/runtime-config`, {
    method: "PATCH", body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.orgRuntimeConfig.findUnique.mockResolvedValue(null); // default config
  prisma.orgRuntimeConfig.upsert.mockResolvedValue({ id: "cfg-1" });
});

describe("runtime-config — RBAC", () => {
  it("403 for a member WITHOUT INTEGRATION_MANAGE", async () => {
    prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme", tenantClass: "COMMERCIAL" });
    getAuthContext.mockResolvedValue(ctx(Permission.PROJECT_READ)); // not INTEGRATION_MANAGE
    const res = await PATCH(patch({ breadthEnabled: false }), { params });
    expect(res.status).toBe(403);
    expect(prisma.orgRuntimeConfig.upsert).not.toHaveBeenCalled();
  });

  it("401 when there's no auth context", async () => {
    prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme", tenantClass: "COMMERCIAL" });
    getAuthContext.mockResolvedValue(null);
    const res = await PATCH(patch({ breadthEnabled: false }), { params });
    expect(res.status).toBe(401);
  });
});

describe("runtime-config — GOV guardrail (tenant-admin cannot lift it)", () => {
  beforeEach(() => {
    prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme", tenantClass: "GOV" });
    getAuthContext.mockResolvedValue(ctx(Permission.INTEGRATION_MANAGE));
  });

  it("REJECTS 400 a GOV org enabling breadth — no DB write", async () => {
    const res = await PATCH(patch({ breadthEnabled: true }), { params });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/breadth|Nango/i) });
    expect(prisma.orgRuntimeConfig.upsert).not.toHaveBeenCalled();
  });

  it("REJECTS 400 a GOV org enabling mcp", async () => {
    const res = await PATCH(patch({ mcpEnabled: true }), { params });
    expect(res.status).toBe(400);
    expect(prisma.orgRuntimeConfig.upsert).not.toHaveBeenCalled();
  });

  it("REJECTS 400 a GOV org listing a commercial-only connector (nango)", async () => {
    const res = await PATCH(patch({ enabledConnectors: ["github", "nango"] }), { params });
    expect(res.status).toBe(400);
    expect(prisma.orgRuntimeConfig.upsert).not.toHaveBeenCalled();
  });

  it("ALLOWS a GOV org a native-only allowlist with breadth/mcp false", async () => {
    const res = await PATCH(patch({ enabledConnectors: ["github", "jira"], breadthEnabled: false }), { params });
    expect(res.status).toBe(200);
    expect(prisma.orgRuntimeConfig.upsert).toHaveBeenCalled();
  });
});

describe("runtime-config — COMMERCIAL org can toggle breadth", () => {
  beforeEach(() => {
    prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme", tenantClass: "COMMERCIAL" });
    getAuthContext.mockResolvedValue(ctx(Permission.INTEGRATION_MANAGE));
  });

  it("a commercial org enabling breadth ⇒ 200 + persisted", async () => {
    const res = await PATCH(patch({ breadthEnabled: true }), { params });
    expect(res.status).toBe(200);
    const upsertArg = prisma.orgRuntimeConfig.upsert.mock.calls[0][0];
    expect(upsertArg.update.breadthEnabled).toBe(true);
  });

  it("enabledConnectors:['github'] ⇒ allowlist ON with that subset", async () => {
    const res = await PATCH(patch({ enabledConnectors: ["github"] }), { params });
    expect(res.status).toBe(200);
    const upsertArg = prisma.orgRuntimeConfig.upsert.mock.calls[0][0];
    expect(upsertArg.update.allowlistEnabled).toBe(true);
    expect(upsertArg.update.enabledConnectors).toEqual(["github"]);
  });

  it("enabledConnectors:null ⇒ allowlist OFF (all enabled)", async () => {
    const res = await PATCH(patch({ enabledConnectors: null }), { params });
    expect(res.status).toBe(200);
    const upsertArg = prisma.orgRuntimeConfig.upsert.mock.calls[0][0];
    expect(upsertArg.update.allowlistEnabled).toBe(false);
    expect(upsertArg.update.enabledConnectors).toEqual([]);
  });

  it("rejects 400 an unknown top-level field (.strict — tenantClass not writable)", async () => {
    const res = await PATCH(patch({ tenantClass: "COMMERCIAL" }), { params });
    expect(res.status).toBe(400);
  });
});

describe("runtime-config — GET", () => {
  it("returns the normalized config + read-only tenantClass (no permissions/BigInt)", async () => {
    prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme", tenantClass: "GOV" });
    getAuthContext.mockResolvedValue(ctx(Permission.INTEGRATION_MANAGE));
    const res = await GET(new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/runtime-config`), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ tenantClass: "GOV", enabledConnectors: null, breadthEnabled: true, mcpEnabled: false });
    expect(Array.isArray(body.availableConnectors)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("permissions");
  });
});
