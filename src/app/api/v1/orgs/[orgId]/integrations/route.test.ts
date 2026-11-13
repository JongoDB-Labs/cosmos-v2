// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    integration: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/integrations/credentials", () => ({ setOrgCredential: vi.fn() }));

import { POST } from "./route";
import "@/lib/integrations/registry/index";

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
function post(body: unknown) {
  return new NextRequest("http://localhost/api/v1/orgs/o/integrations", {
    method: "POST", body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.integration.create.mockResolvedValue({ id: "int-1" });
  getAuthContext.mockResolvedValue(ctx());
});

describe("POST /integrations guardrail", () => {
  it("rejects installing a coming_soon provider (basecamp) with 400 and no DB write", async () => {
    // basecamp is still status:"coming_soon" (slack/jira were promoted to available
    // as native token-auth connectors in v2.20 — see the connector registry).
    const res = await POST(post({ provider: "basecamp" }), { params });
    expect(res.status).toBe(400);
    expect(prisma.integration.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider with 400", async () => {
    const res = await POST(post({ provider: "totally-unknown" }), { params });
    expect(res.status).toBe(400);
    expect(prisma.integration.create).not.toHaveBeenCalled();
  });
});

describe("POST /integrations: a site URL Cosmos will call", () => {
  const jira = (baseUrl: string) =>
    post({ provider: "jira", config: { email: "a@example.com", apiToken: "t", baseUrl } });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/",
    "http://[fd00:ec2::254]/",
    "http://10.0.0.5/",
    "http://localhost:8080/",
    "file:///etc/passwd",
  ])("refuses %s with 400 and saves nothing", async (baseUrl) => {
    vi.stubEnv("OUTBOUND_ALLOW_PRIVATE_CIDRS", "");
    const res = await POST(jira(baseUrl), { params });
    expect(res.status).toBe(400);
    expect(prisma.integration.create).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("saves a public site (control)", async () => {
    const res = await POST(jira("https://example.atlassian.net"), { params });
    expect(res.status).toBe(201);
    expect(prisma.integration.create).toHaveBeenCalledTimes(1);
  });

  it("saves a private site only inside the operator's ranges", async () => {
    vi.stubEnv("OUTBOUND_ALLOW_PRIVATE_CIDRS", "10.0.0.0/8");
    const res = await POST(jira("http://10.0.0.5/"), { params });
    expect(res.status).toBe(201);
    vi.unstubAllEnvs();
  });
});
