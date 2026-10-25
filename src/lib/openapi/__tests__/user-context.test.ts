// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  authorization: null as string | null,
  getCurrentUser: vi.fn(),
  bearerIpAllowed: vi.fn(),
  verifyKeyTokenHolder: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(h.authorization ? { authorization: h.authorization } : {}) }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: h.getCurrentUser, bearerIpAllowed: h.bearerIpAllowed }));
vi.mock("@/lib/auth/api-key", () => ({ verifyKeyTokenHolder: h.verifyKeyTokenHolder }));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));

import { userContext } from "../user-context";

const HOLDER = { userId: "u-token", orgId: "o1", scopes: ["read"], keyId: "k1", kind: "PERSONAL", expiresAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  h.authorization = null;
  h.getCurrentUser.mockResolvedValue({ id: "u-cookie" });
  h.bearerIpAllowed.mockResolvedValue(true);
  h.verifyKeyTokenHolder.mockResolvedValue(HOLDER);
});

describe("userContext: who is calling a route with no org in the path", () => {
  it("a session is the cookie's user, with no token", async () => {
    expect(await userContext({ scopes: [] })).toEqual({ userId: "u-cookie" });
  });

  it("a key token is its holder, with the token's org and scopes", async () => {
    h.authorization = "Bearer cosmos_abc_s";
    expect(await userContext({ scopes: [] })).toEqual({
      userId: "u-token", token: { orgId: "o1", scopes: ["read"], keyId: "k1", kind: "PERSONAL", expiresAt: null },
    });
    expect(h.getCurrentUser).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown key", "Bearer cosmos_abc_s", () => h.verifyKeyTokenHolder.mockResolvedValue(null)],
    ["a key from outside the org's IP allowlist", "Bearer cosmos_abc_s", () => h.bearerIpAllowed.mockResolvedValue(false)],
    ["an OAuth token (not yet accepted)", "Bearer cosmos_oat_0f_s", () => {}],
    ["a malformed cosmos bearer", "Bearer cosmos_", () => {}],
  ])("%s is a 401, never the cookie on the same request", async (_n, header, arrange) => {
    h.authorization = header;
    arrange();
    await expect(userContext({ scopes: [] })).rejects.toMatchObject({ status: 401 });
    expect(h.getCurrentUser).not.toHaveBeenCalled();
  });

  it("holds the token to the contract's scopes", async () => {
    h.authorization = "Bearer cosmos_abc_s";
    await expect(userContext({ scopes: ["members:read"] })).rejects.toMatchObject({ status: 403, code: "insufficient_scope" });
  });
});
