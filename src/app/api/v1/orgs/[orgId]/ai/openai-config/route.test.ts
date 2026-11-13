// @vitest-environment node
// The OpenAI-compatible base URL is an endpoint Cosmos will call with the
// org's API key, so it is refused at save time when it points at a link-local
// or metadata address, or at a private one the operator hasn't allowed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const { getAuthContext, prisma, setOpenAiConfig } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: { organization: { findUnique: vi.fn() } },
  setOpenAiConfig: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/ai/ai-credentials", () => ({ setOpenAiConfig }));

import { POST } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const params = Promise.resolve({ orgId: ORG_ID });
const ctx = (): AuthContext => ({
  userId: "44444444-4444-4444-4444-444444444444", orgId: ORG_ID, orgRole: OrgRole.ADMIN,
  permissions: Permission.ORG_MANAGE_SETTINGS, basePermissions: Permission.ORG_MANAGE_SETTINGS, abacRules: [],
});
const post = (baseUrl: string) =>
  new NextRequest("http://localhost/api/v1/orgs/o/ai/openai-config", {
    method: "POST", body: JSON.stringify({ apiKey: "k", baseUrl, model: "m" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue(ctx());
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /ai/openai-config base URL", () => {
  it.each(["http://169.254.169.254/v1", "http://metadata.google.internal/v1", "http://[fd00:ec2::254]/v1", "http://10.1.2.3/v1", "ftp://example.com/v1"])(
    "refuses %s and stores nothing",
    async (baseUrl) => {
      vi.stubEnv("OUTBOUND_ALLOW_PRIVATE_CIDRS", "");
      const res = await POST(post(baseUrl), { params });
      expect(res.status).toBe(400);
      expect(setOpenAiConfig).not.toHaveBeenCalled();
    },
  );

  it("stores a public endpoint (control)", async () => {
    const res = await POST(post("https://llm.example.com/v1"), { params });
    expect(res.status).toBe(200);
    expect(setOpenAiConfig).toHaveBeenCalledTimes(1);
  });

  it("stores a self-hosted endpoint inside the operator's ranges", async () => {
    vi.stubEnv("OUTBOUND_ALLOW_PRIVATE_CIDRS", "10.0.0.0/8");
    const res = await POST(post("http://10.1.2.3/v1"), { params });
    expect(res.status).toBe(200);
  });
});
