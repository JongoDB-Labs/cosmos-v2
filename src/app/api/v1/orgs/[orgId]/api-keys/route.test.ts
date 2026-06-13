// @vitest-environment node
//
// RBAC + secret-hygiene lock for the API-key mint/list routes
// (POST/GET .../api-keys). Mock ONLY the I/O boundaries (session, prisma,
// mintApiKey) and assert:
//   - POST with API_KEY_MANAGE → 201 and the response carries the one-time `token`.
//   - POST without API_KEY_MANAGE (permissions = 0n) → 403, mintApiKey NOT called.
//   - GET projection never includes `keyHash`.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

// --- I/O boundary mocks ------------------------------------------------------
const { getAuthContext, prisma, mintApiKey } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    apiKey: { findMany: vi.fn() },
  },
  mintApiKey: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/api-key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/api-key")>();
  return { ...actual, mintApiKey };
});

import { GET, POST } from "./route";

// --- ctx + fixture helpers ---------------------------------------------------
const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";
const KEY_ID = "55555555-5555-5555-5555-555555555555";

function ctxWith(permissions: bigint): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: OrgRole.ADMIN,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  };
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/api-keys`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function getRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/api-keys`, {
    method: "GET",
  });
}

const params = Promise.resolve({ orgId: ORG_ID });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
});

describe("POST /api-keys — mint", () => {
  it("with API_KEY_MANAGE → 201 and the response includes a token", async () => {
    getAuthContext.mockResolvedValue(ctxWith(Permission.API_KEY_MANAGE));
    mintApiKey.mockResolvedValue({
      token: "cosmos_abc123_secretsecretsecret",
      record: {
        id: KEY_ID,
        name: "CI bot",
        prefix: "abc123",
        scopes: ["read"],
        expiresAt: null,
        createdAt: new Date(),
      },
    });

    const res = await POST(
      postRequest({ name: "CI bot", scopes: ["read"] }),
      { params },
    );

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.token).toBe("cosmos_abc123_secretsecretsecret");
    expect(mintApiKey).toHaveBeenCalledTimes(1);
    expect(mintApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        name: "CI bot",
        scopes: ["read"],
        createdById: ACTOR_ID,
      }),
    );
  });

  it("without API_KEY_MANAGE → 403 and mintApiKey is never called", async () => {
    getAuthContext.mockResolvedValue(ctxWith(0n));

    const res = await POST(
      postRequest({ name: "CI bot", scopes: ["read"] }),
      { params },
    );

    expect(res.status).toBe(403);
    expect(mintApiKey).not.toHaveBeenCalled();
  });
});

describe("GET /api-keys — list", () => {
  it("never selects or returns keyHash", async () => {
    getAuthContext.mockResolvedValue(ctxWith(Permission.API_KEY_MANAGE));
    prisma.apiKey.findMany.mockResolvedValue([
      {
        id: KEY_ID,
        name: "CI bot",
        prefix: "abc123",
        scopes: ["read"],
        expiresAt: null,
        lastUsed: null,
        createdAt: new Date(),
      },
    ]);

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(200);
    // The Prisma `select` must not request keyHash.
    const selectArg = prisma.apiKey.findMany.mock.calls[0][0].select;
    expect(selectArg.keyHash).toBeUndefined();

    const json = await res.json();
    const body = JSON.stringify(json);
    expect(body).not.toContain("keyHash");
  });
});
