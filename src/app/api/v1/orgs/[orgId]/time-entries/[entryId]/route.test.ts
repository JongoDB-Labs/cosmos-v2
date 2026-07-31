// @vitest-environment node
//
// Read scoping on the SINGLE-entry route. The list route's leak had a twin
// here: `requirePermission(ctx, TIME_READ)` then `findFirst({ id, orgId })`
// with no owner predicate, so anyone holding TIME_READ — MEMBER and VIEWER
// both do — could fetch any entry in the org by id, rate included.
//
// The scope is folded into the WHERE rather than checked after the row is
// loaded, so "not yours" and "does not exist" are the same 404. Returning 403
// for the former would confirm an entry exists, which is itself something an
// actor without access should not be able to learn.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    timeEntry: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

import { GET } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";
const OTHER_ID = "55555555-5555-5555-5555-555555555555";
const ENTRY_ID = "77777777-7777-7777-7777-777777777777";

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

const params = Promise.resolve({ orgId: ORG_ID, entryId: ENTRY_ID });

function getRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/orgs/o/time-entries/${ENTRY_ID}`,
    { method: "GET" },
  );
}

/** The `where` the route actually handed Prisma. */
function lastWhere(): Record<string, unknown> {
  const call = prisma.timeEntry.findFirst.mock.calls.at(-1);
  return (call?.[0] as { where: Record<string, unknown> }).where;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
});

describe("GET /time-entries/[entryId] — read scoping", () => {
  it("plain TIME_READ constrains the lookup to the actor's own entries", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ")));
    prisma.timeEntry.findFirst.mockResolvedValue(null);

    await GET(getRequest(), { params });

    expect(lastWhere().userId).toBe(ACTOR_ID);
  });

  it("another user's entry is a 404, indistinguishable from one that never existed", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ")));
    // The mock HONOURS the where-clause rather than returning a fixed null.
    // Hard-coding null would pass whether or not the route scoped the query —
    // it would assert "null yields 404", which was never in doubt. Filtering
    // for real is what makes this a guard: drop the owner constraint and the
    // row comes back with a 200.
    prisma.timeEntry.findFirst.mockImplementation(
      ({ where }: { where: { userId?: string } }) => {
        const row = { id: ENTRY_ID, userId: OTHER_ID, rate: "225" };
        return Promise.resolve(
          where.userId && where.userId !== row.userId ? null : row,
        );
      },
    );

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(404);
  });

  it("TIME_READ_ALL lifts the owner constraint", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ", "TIME_READ_ALL")));
    prisma.timeEntry.findFirst.mockResolvedValue({
      id: ENTRY_ID,
      userId: OTHER_ID,
      rate: "225",
    });

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(200);
    expect(lastWhere().userId).toBeUndefined();
  });

  it("redacts the rate on someone else's entry without FINANCE_READ", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ", "TIME_READ_ALL")));
    prisma.timeEntry.findFirst.mockResolvedValue({
      id: ENTRY_ID,
      userId: OTHER_ID,
      rate: "225",
    });

    const body = await (await GET(getRequest(), { params })).json();

    expect(body.id).toBe(ENTRY_ID);
    expect(body.rate).toBeNull();
  });

  it("keeps the rate on one's own entry", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ")));
    prisma.timeEntry.findFirst.mockResolvedValue({
      id: ENTRY_ID,
      userId: ACTOR_ID,
      rate: "150",
    });

    const body = await (await GET(getRequest(), { params })).json();

    expect(body.rate).toBe("150");
  });

  it("ctx lacking TIME_READ → 403, never queries", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("ORG_READ")));

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.timeEntry.findFirst).not.toHaveBeenCalled();
  });
});
