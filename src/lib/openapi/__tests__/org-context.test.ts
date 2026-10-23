import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAuthContext, findUnique } = vi.hoisted(() => ({ getAuthContext: vi.fn(), findUnique: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma: { organization: { findUnique } } }));

import { assertScopes, orgContext } from "../org-context";
import { ProblemError } from "../problem";
import { API_VERSION, SUPPORTED_API_VERSIONS } from "../version";

const READ = { scopes: ["read" as const] };

beforeEach(() => vi.clearAllMocks());

describe("orgContext", () => {
  it("resolves the org by id and the caller within it by slug", async () => {
    findUnique.mockResolvedValue({ id: "o1", slug: "acme" });
    getAuthContext.mockResolvedValue({ userId: "u1" });
    expect(await orgContext("o1", READ)).toEqual({
      org: { id: "o1", slug: "acme" }, ctx: { userId: "u1" }, apiVersion: API_VERSION,
    });
    expect(getAuthContext).toHaveBeenCalledWith("acme");
  });

  it("an unknown org is a 404 problem, before any auth lookup", async () => {
    findUnique.mockResolvedValue(null);
    await expect(orgContext("o1", READ)).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(getAuthContext).not.toHaveBeenCalled();
  });

  it("no caller is a 401 problem", async () => {
    findUnique.mockResolvedValue({ id: "o1", slug: "acme" });
    getAuthContext.mockResolvedValue(null);
    const err = await orgContext("o1", READ).catch((e) => e);
    expect(err).toBeInstanceOf(ProblemError);
    expect(err).toMatchObject({ status: 401, code: "unauthorized" });
  });
});

describe("orgContext: the API version a request runs at", () => {
  const RETIRED = "2025-01-01";
  beforeEach(() => {
    findUnique.mockResolvedValue({ id: "o1", slug: "acme" });
    SUPPORTED_API_VERSIONS[RETIRED] = { deprecatedAt: "2025-06-01", sunsetAt: "2026-06-01" };
    return () => { delete SUPPORTED_API_VERSIONS[RETIRED]; };
  });
  const runningAt = (apiVersion?: string) => getAuthContext.mockResolvedValue({ userId: "u1", apiVersion });

  it("is the context's version, current when unset", async () => {
    runningAt("2026-11-01");
    expect((await orgContext("o1", READ)).apiVersion).toBe("2026-11-01");
    runningAt(undefined);
    expect((await orgContext("o1", READ)).apiVersion).toBe(API_VERSION);
  });

  it("a request running at a retired version (a token's old pin) is a 410", async () => {
    runningAt(RETIRED);
    await expect(orgContext("o1", READ)).rejects.toMatchObject({ status: 410, code: "unsupported_api_version" });
  });
});

describe("assertScopes: a token holds what the operation names", () => {
  const ctx = (scopes?: string[]) => ({ userId: "u", orgId: "o", orgRole: "MEMBER", permissions: 0n, basePermissions: 0n, abacRules: [], scopes }) as never;
  const err = (fn: () => void) => { try { fn(); } catch (e) { return e as ProblemError; } throw new Error("did not throw"); };

  it("a browser session (no scopes) is not checked: it carries the user's own permissions", () => {
    expect(() => assertScopes(ctx(undefined), { scopes: ["items:delete"] })).not.toThrow();
  });

  it("passes when every named scope is held", () => {
    expect(() => assertScopes(ctx(["planning:write", "items:delete"]), { scopes: ["planning:write", "items:delete"] })).not.toThrow();
  });

  it("write implies read; time:write implies time:read", () => {
    expect(() => assertScopes(ctx(["items:write"]), { scopes: ["read"] })).not.toThrow();
    expect(() => assertScopes(ctx(["time:write"]), { scopes: ["time:read"] })).not.toThrow();
  });

  it("nothing implies a delete, or member access", () => {
    expect(err(() => assertScopes(ctx(["items:write"]), { scopes: ["items:delete"] })).code).toBe("insufficient_scope");
    expect(err(() => assertScopes(ctx(["read", "items:write"]), { scopes: ["members:read"] })).status).toBe(403);
  });

  it("refuses with the RFC 6750 step-up challenge naming the scopes to ask for", () => {
    const e = err(() => assertScopes(ctx(["read"]), { scopes: ["planning:write", "items:delete"] }));
    expect(e.message).toMatch(/planning:write, items:delete scopes/);
    expect(new Headers(e.headers).get("www-authenticate"))
      .toBe('Bearer error="insufficient_scope", scope="read planning:write items:delete"');
  });

  it("an unknown scope string grants nothing", () => {
    expect(() => assertScopes(ctx(["admin", "*"]), { scopes: ["read"] })).toThrow(ProblemError);
  });
});
