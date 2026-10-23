// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  headers: {} as Record<string, string>,
  verifyApiKeyHeader: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(h.headers),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    organization: { findUnique: vi.fn(async () => ({ id: "o1", slug: "acme" })) },
    orgSecuritySettings: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("../api-key", () => ({ verifyApiKeyHeader: h.verifyApiKeyHeader }));

import { getAuthContext } from "../session";
import { API_VERSION } from "@/lib/openapi/version";

const PINNED = "2025-01-01";

beforeEach(() => {
  h.headers = { authorization: "Bearer cosmos_abc_s" };
  h.verifyApiKeyHeader.mockResolvedValue({
    userId: "u1", orgId: "o1",
    credential: { kind: "api_key", keyId: "k", personal: true, apiVersion: PINNED },
  });
});

describe("getAuthContext: the API version a token's request runs at", () => {
  it("is the token's pin when the request names none", async () => {
    expect((await getAuthContext("acme"))?.apiVersion).toBe(PINNED);
  });

  it("is the version the request names, over the pin", async () => {
    h.headers["cosmos-api-version"] = API_VERSION;
    expect((await getAuthContext("acme"))?.apiVersion).toBe(API_VERSION);
  });
});
