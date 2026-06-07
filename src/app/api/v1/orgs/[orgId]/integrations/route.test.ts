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
