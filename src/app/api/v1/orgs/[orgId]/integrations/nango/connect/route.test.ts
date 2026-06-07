// @vitest-environment node
//
// Nango connect route — D5 gov-block LAYER 4 (the connect ROUTE refuses for a gov
// org with 403) + the commercial happy path. Auth + prisma + the Nango wrapper are
// mocked. Proves: gov org → 403 (audited, no Nango call); commercial org →
// createConnectSession; not-configured → 503; missing perm → 403 (ForbiddenError).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, createConnectSession, nangoEnabled, logAudit } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: { organization: { findUnique: vi.fn() } },
  createConnectSession: vi.fn(),
  nangoEnabled: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));
vi.mock("@/lib/integrations/nango", () => ({ createConnectSession, nangoEnabled }));

import { POST } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const params = Promise.resolve({ orgId: ORG_ID });

function ctx(): AuthContext {
  return {
    userId: "44444444-4444-4444-4444-444444444444",
    orgId: ORG_ID, orgRole: OrgRole.ADMIN,
    permissions: Permission.INTEGRATION_MANAGE,
    basePermissions: Permission.INTEGRATION_MANAGE, abacRules: [],
  };
}
function post(body: unknown = { provider: "hubspot" }) {
  return new NextRequest("http://localhost/api/v1/orgs/o/integrations/nango/connect", {
    method: "POST", body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContext.mockResolvedValue(ctx());
  nangoEnabled.mockReturnValue(true);
  createConnectSession.mockResolvedValue({ token: "sess-tok", connect_link: "http://x", expires_at: "z" });
});

describe("L4 — gov org is refused with 403, never reaching Nango", () => {
  it("403 for an explicit GOV org; createConnectSession is never called; refusal audited", async () => {
    prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme", tenantClass: "GOV" });
    const res = await POST(post(), { params });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/commercial-only|not available/i);
    expect(createConnectSession).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "integration.nango.connect.denied_gov" }));
  });

  it("403 for ANY non-COMMERCIAL tenantClass (fail-closed)", async () => {
    prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme", tenantClass: "SOMETHING_ELSE" });
    const res = await POST(post(), { params });
    expect(res.status).toBe(403);
    expect(createConnectSession).not.toHaveBeenCalled();
  });
});

describe("commercial org — creates the connect session", () => {
  beforeEach(() => {
    prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme", tenantClass: "COMMERCIAL" });
  });

  it("200 + the session token for a commercial org", async () => {
    const res = await POST(post(), { params });
    expect(res.status).toBe(200);
    expect(createConnectSession).toHaveBeenCalledWith(ORG_ID, "hubspot");
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "integration.nango.connect.session_created" }));
  });

  it("503 when Nango is not configured", async () => {
    nangoEnabled.mockReturnValue(false);
    const res = await POST(post(), { params });
    expect(res.status).toBe(503);
    expect(createConnectSession).not.toHaveBeenCalled();
  });

  it("502 when the wrapper returns a graceful error (e.g. not connected)", async () => {
    createConnectSession.mockResolvedValue({ error: "not configured" });
    const res = await POST(post(), { params });
    expect(res.status).toBe(502);
  });

  it("400 on a missing provider (schema validation)", async () => {
    const res = await POST(post({}), { params });
    expect(res.status).toBe(400);
  });
});

describe("auth", () => {
  it("404 when the org doesn't exist", async () => {
    prisma.organization.findUnique.mockResolvedValue(null);
    const res = await POST(post(), { params });
    expect(res.status).toBe(404);
  });

  it("401 when unauthenticated", async () => {
    prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme", tenantClass: "COMMERCIAL" });
    getAuthContext.mockResolvedValue(null);
    const res = await POST(post(), { params });
    expect(res.status).toBe(401);
  });

  it("403 (ForbiddenError) when the user lacks INTEGRATION_MANAGE", async () => {
    prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme", tenantClass: "COMMERCIAL" });
    getAuthContext.mockResolvedValue({ ...ctx(), permissions: 0n, basePermissions: 0n });
    const res = await POST(post(), { params });
    expect(res.status).toBe(403);
  });
});
