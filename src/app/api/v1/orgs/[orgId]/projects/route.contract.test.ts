// @vitest-environment node
//
// GET /orgs/{orgId}/projects through its contract: query parsing, problem
// errors, opt-in paging. Visibility rules live in list-scoping.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";
import { projectRow } from "@/lib/openapi/testing/rows";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    project: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { GET } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ orgId: ORG_ID });

function ctx(over: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "44444444-4444-4444-8444-444444444444", orgId: ORG_ID, orgRole: OrgRole.OWNER,
    permissions: Permission.PROJECT_READ, basePermissions: Permission.PROJECT_READ, abacRules: [],
    ...over,
  };
}

const row = (i: number) => projectRow({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, orgId: ORG_ID, name: `P${i}`, key: `P${i}`,
  projectTemplate: { sector: "software" }, enabledFeatures: ["risk"],
  createdAt: new Date(Date.UTC(2026, 9, 30 - i)), updatedAt: new Date(Date.UTC(2026, 9, 30)),
});

const pagingCalls = () =>
  prisma.project.findMany.mock.calls.map((c: unknown[]) => c[0] as { orderBy?: unknown; take?: number; where: { AND: Record<string, unknown>[] } })
    .filter((a) => a.orderBy);

const get = (qs = "", headers: Record<string, string> = {}) =>
  GET(new NextRequest(`http://localhost:3000/api/v1/orgs/${ORG_ID}/projects${qs}`, { headers }), { params });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.project.findMany.mockImplementation(async (args: { take?: number; select?: unknown }) =>
    args.select
      ? Array.from({ length: 120 }, (_, i) => ({ id: row(i).id }))
      : Array.from({ length: Math.min(args.take ?? 120, 120) }, (_, i) => row(i)));
});

describe("GET projects: the contract", () => {
  it.each([
    ["a browser (cookie) caller", {}],
    ["an API key that sends no paging params (existing clients)", { isApiKey: true, scopes: ["read"] }],
  ])("%s still gets every project in one array", async (_n, over) => {
    getAuthContext.mockResolvedValue(ctx(over));
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(120);
    expect(res.headers.get("link")).toBeNull();
    expect(pagingCalls()[0].take).toBeUndefined();
  });

  it("returns the documented shape, with the template flattened to `sector`", async () => {
    getAuthContext.mockResolvedValue(ctx());
    const [first] = await (await get()).json();
    expect(first.sector).toBe("software");
    expect(first.enabledFeatures).toEqual(["risk"]); // the board tabs read it
    expect(first).not.toHaveProperty("projectTemplate");
    expect(first.createdAt).toBe("2026-10-30T00:00:00.000Z");
  });

  it("a caller that asks for pages gets them, with a Link to the rest on the public origin", async () => {
    getAuthContext.mockResolvedValue(ctx({ isApiKey: true, scopes: ["read"] }));
    const res = await get("?limit=50", { "x-forwarded-host": "cosmos.example.gov", "x-forwarded-proto": "https" });
    expect(await res.json()).toHaveLength(50);
    expect(pagingCalls()[0].take).toBe(51);
    expect(res.headers.get("link")).toMatch(/^<https:\/\/cosmos\.example\.gov\/api\/v1\/orgs\/.+\/projects\?limit=50&cursor=/);
  });

  it("follows a cursor with a keyset WHERE, keeping the org and archived filter", async () => {
    getAuthContext.mockResolvedValue(ctx({ isApiKey: true, scopes: ["read"] }));
    const cursor = (await get("?limit=2")).headers.get("cosmos-next-cursor")!;
    const second = await get(`?limit=2&cursor=${cursor}`);
    expect(second.status, JSON.stringify(await second.clone().json())).toBe(200);
    // The paging queries are the ones with an orderBy; visibility does its own lookup.
    const where = pagingCalls()[1].where;
    expect(where.AND[0]).toMatchObject({ orgId: ORG_ID, archived: false });
    expect(where.AND[1].OR).toHaveLength(2);
  });

  it("an unknown query parameter is ignored, as it was before the contract (cache-busters)", async () => {
    getAuthContext.mockResolvedValue(ctx());
    const res = await get("?_=1729700000");
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(120);
  });

  it("an invalid value for `archived` is a 400 naming it", async () => {
    getAuthContext.mockResolvedValue(ctx());
    const res = await get("?archived=maybe");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_request");
    expect(JSON.stringify(body.issues)).toContain("archived");
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it.each([["true", true], ["1", true], ["false", false], ["0", false]])(
    "`archived=%s` lists %s projects", async (v, archived) => {
      getAuthContext.mockResolvedValue(ctx());
      await get(`?archived=${v}`);
      expect(pagingCalls()[0].where.AND[0]).toMatchObject({ orgId: ORG_ID, archived });
    },
  );

  it("a malformed org id is a 400 before any lookup; an unknown org a 404 problem", async () => {
    const bad = await GET(new NextRequest("http://localhost/api/v1/orgs/nope/projects"), { params: Promise.resolve({ orgId: "nope" }) });
    expect(bad.status).toBe(400);
    expect(prisma.organization.findUnique).not.toHaveBeenCalled();
    prisma.organization.findUnique.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });

  it("no session and no key is a 401 problem", async () => {
    getAuthContext.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
  });
});

describe("GET projects: the scope gate", () => {
  it("a token without `read` (or a write scope implying it) is refused 403 with a step-up challenge", async () => {
    getAuthContext.mockResolvedValue(ctx({ isApiKey: true, scopes: ["time:write"] }));
    const res = await get();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("insufficient_scope");
    expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it("an items:write token passes the gate (write implies read)", async () => {
    getAuthContext.mockResolvedValue(ctx({ isApiKey: true, scopes: ["items:write"] }));
    expect((await get()).status).toBe(200);
  });
});
