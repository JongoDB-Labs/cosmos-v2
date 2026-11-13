// @vitest-environment node
// Changing an integration's site URL gets the same check as installing it: a
// URL Cosmos will call is never a link-local or metadata address, and a
// private one only inside the operator's OUTBOUND_ALLOW_PRIVATE_CIDRS.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    integration: { findFirst: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/integrations/credentials", () => ({ setOrgCredential: vi.fn(), deleteOrgCredential: vi.fn() }));

import { PUT } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const INT_ID = "22222222-2222-2222-2222-222222222222";
const params = Promise.resolve({ orgId: ORG_ID, integrationId: INT_ID });

function ctx(): AuthContext {
  return {
    userId: "44444444-4444-4444-4444-444444444444",
    orgId: ORG_ID, orgRole: OrgRole.ADMIN,
    permissions: Permission.INTEGRATION_MANAGE,
    basePermissions: Permission.INTEGRATION_MANAGE, abacRules: [],
  };
}
const put = (baseUrl: string) =>
  new NextRequest("http://localhost/api/v1/orgs/o/integrations/i", {
    method: "PUT", body: JSON.stringify({ config: { baseUrl } }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.integration.findFirst.mockResolvedValue({ id: INT_ID, orgId: ORG_ID, provider: "jira", config: {} });
  prisma.integration.update.mockResolvedValue({ id: INT_ID, provider: "jira" });
  getAuthContext.mockResolvedValue(ctx());
});
afterEach(() => vi.unstubAllEnvs());

describe("PUT /integrations/[id]: a site URL Cosmos will call", () => {
  it.each(["http://169.254.169.254/", "http://metadata.goog/", "http://[::ffff:169.254.169.254]/", "http://192.168.1.10/"])(
    "refuses %s with 400 and changes nothing",
    async (baseUrl) => {
      vi.stubEnv("OUTBOUND_ALLOW_PRIVATE_CIDRS", "");
      const res = await PUT(put(baseUrl), { params });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/Site base URL/);
      expect(prisma.integration.update).not.toHaveBeenCalled();
    },
  );

  it("saves a public site (control)", async () => {
    const res = await PUT(put("https://example.atlassian.net"), { params });
    expect(res.status).toBe(200);
    expect(prisma.integration.update).toHaveBeenCalledTimes(1);
  });
});
