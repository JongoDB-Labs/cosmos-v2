import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAuthContext, findUnique } = vi.hoisted(() => ({ getAuthContext: vi.fn(), findUnique: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma: { organization: { findUnique } } }));

import { assertScopes, orgContext } from "../org-context";
import { ProblemError } from "../problem";
import { listMembers } from "@/app/api/v1/orgs/[orgId]/members/route.contract";
import { createMilestone } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/milestones/route.contract";
import { updateMilestone, deleteMilestone } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/milestones/[milestoneId]/route.contract";
import { createKpi } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/kpis/route.contract";
import { updateKpi, deleteKpi } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/kpis/[kpiId]/route.contract";
import { createKpiDataPoint } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/kpis/[kpiId]/data-points/route.contract";

const READ = { scopes: ["read" as const] };

beforeEach(() => vi.clearAllMocks());

describe("orgContext", () => {
  it("resolves the org by id and the caller within it by slug", async () => {
    findUnique.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111", slug: "acme" });
    getAuthContext.mockResolvedValue({ userId: "u1" });
    expect(await orgContext("11111111-1111-4111-8111-111111111111", READ)).toEqual({ org: { id: "11111111-1111-4111-8111-111111111111", slug: "acme" }, ctx: { userId: "u1" } });
    expect(getAuthContext).toHaveBeenCalledWith("acme");
  });

  it("an unknown org is a 404 problem, before any auth lookup", async () => {
    findUnique.mockResolvedValue(null);
    await expect(orgContext("11111111-1111-4111-8111-111111111111", READ)).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(getAuthContext).not.toHaveBeenCalled();
  });

  it("no caller is a 401 problem", async () => {
    findUnique.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111", slug: "acme" });
    getAuthContext.mockResolvedValue(null);
    const err = await orgContext("11111111-1111-4111-8111-111111111111", READ).catch((e) => e);
    expect(err).toBeInstanceOf(ProblemError);
    expect(err).toMatchObject({ status: 401, code: "unauthorized" });
  });
});

describe("orgContext: the org id's shape", () => {
  it("a non-UUID org id is a 400, before any lookup", async () => {
    await expect(orgContext("nope", READ)).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("assertScopes: a token holds what the operation names", () => {
  const ctx = (scopes?: string[]) => ({ userId: "u", orgId: "o", orgRole: "MEMBER", permissions: 0n, basePermissions: 0n, abacRules: [], scopes, isApiKey: scopes !== undefined }) as never;
  const err = (fn: () => void) => { try { fn(); } catch (e) { return e as ProblemError; } throw new Error("did not throw"); };

  it("an operation that names no scope refuses every key (default-deny), but not a session", () => {
    expect(err(() => assertScopes(ctx(["read", "items:write", "items:delete"]), { scopes: [] })).status).toBe(403);
    expect(() => assertScopes(ctx(undefined), { scopes: [] })).not.toThrow();
  });

  it("a key context without its scopes is refused, not waved through", () => {
    const keyWithoutScopes = { userId: "u", orgId: "o", orgRole: "OWNER", permissions: -1n, basePermissions: -1n, abacRules: [], isApiKey: true } as never;
    expect(err(() => assertScopes(keyWithoutScopes, { scopes: ["read"] })).code).toBe("insufficient_scope");
  });

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

  it("items:write passes the planning:write gate: keys minted before the split keep editing milestones and KPIs", () => {
    expect(() => assertScopes(ctx(["items:write"]), { scopes: ["planning:write"] })).not.toThrow();
    // ...but not the other way: a planning token can't edit work items.
    expect(err(() => assertScopes(ctx(["planning:write"]), { scopes: ["items:write"] })).status).toBe(403);
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

describe("keys minted before the new scopes keep what they could do", () => {
  const key = (scopes: string[]) => ({ userId: "u", orgId: "o", orgRole: "MEMBER", permissions: 0n, basePermissions: 0n, abacRules: [], scopes, isApiKey: true }) as never;

  // These gate on PROJECT_UPDATE, which items:write carries: an items:write key
  // could create, edit and delete milestones and KPIs before planning:write
  // existed. A scope on any of them that items:write doesn't cover breaks it.
  it.each([createMilestone, updateMilestone, deleteMilestone, createKpi, updateKpi, deleteKpi, createKpiDataPoint])(
    "an items:write key still passes $operationId's gate",
    (contract) => {
      expect(() => assertScopes(key(["items:write"]), contract)).not.toThrow();
    },
  );

  it("a read key still lists members (emails stay behind members:read)", () => {
    expect(() => assertScopes(key(["read"]), listMembers)).not.toThrow();
  });
});
