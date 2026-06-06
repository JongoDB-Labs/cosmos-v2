// @vitest-environment node
//
// List-envelope CONTRACT test. The list routes return `success({ data, total })`
// — NOT a bare array. Clients MUST read `.data` (and `.total` for pagination).
// Conflating the envelope with a bare array has caused 3 prod bugs (a client did
// `res.map(...)` on `{data,total}` and rendered nothing). This test LOCKS the
// shape so a refactor that drops `data` or `total`, or that returns the array
// directly, fails CI loudly. See work-items route.test.ts for the harness doc.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    timeEntry: { findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

import { GET } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}

function ctxWith(permissions: bigint): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  };
}

function getRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/v1/orgs/o/time-entries${query}`, {
    method: "GET",
  });
}

const params = Promise.resolve({ orgId: ORG_ID });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
});

describe("GET /time-entries — { data, total } list-envelope contract", () => {
  it("returns BOTH `data` (array) and `total` (number) keys", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ")));
    const rows = [
      { id: "e1", hours: 2 },
      { id: "e2", hours: 3 },
    ];
    prisma.timeEntry.findMany.mockResolvedValue(rows);
    prisma.timeEntry.count.mockResolvedValue(2);

    const res = await GET(getRequest(), { params });
    expect(res.status).toBe(200);

    const body = await res.json();
    // The contract: an ENVELOPE, not a bare array. Both keys, correct types.
    expect(Array.isArray(body)).toBe(false);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(typeof body.total).toBe("number");
    expect(body.total).toBe(2);
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("total");
  });

  it("`total` reflects the full count, independent of the returned page", async () => {
    // total comes from a separate count() — it can exceed data.length when paged.
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ")));
    prisma.timeEntry.findMany.mockResolvedValue([{ id: "e1", hours: 2 }]);
    prisma.timeEntry.count.mockResolvedValue(57);

    const res = await GET(getRequest(), { params });
    const body = await res.json();

    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(57);
  });

  it("empty result is still the envelope: data:[] + total:0 (not null/array)", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ")));
    prisma.timeEntry.findMany.mockResolvedValue([]);
    prisma.timeEntry.count.mockResolvedValue(0);

    const res = await GET(getRequest(), { params });
    const body = await res.json();

    expect(body).toEqual({ data: [], total: 0 });
  });

  it("ctx lacking TIME_READ → 403 (no envelope, never queries)", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("ORG_READ")));

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.timeEntry.findMany).not.toHaveBeenCalled();
  });
});
