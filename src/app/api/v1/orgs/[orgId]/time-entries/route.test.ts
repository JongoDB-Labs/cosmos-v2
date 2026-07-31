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
    // isProjectVisible reads this. Unset it returns undefined → "no such
    // project" → denied, which is the deny-safe default we want in tests.
    project: { findFirst: vi.fn() },
    projectMember: { findFirst: vi.fn() },
    orgMember: { findUnique: vi.fn() },
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

/**
 * TIME_READ is held by MEMBER *and* VIEWER. Before this, GET applied no owner
 * scoping and `userId` was an optional filter the client never sent — so the
 * default response was every entry in the org, each carrying its `rate`. Any
 * read-only viewer could enumerate the company's hours and billing rates.
 *
 * These assert the SCOPE of the query, not just the response shape: a test that
 * only checked the returned rows would pass against the bug, because findMany
 * is mocked and returns whatever it is told regardless of `where`.
 */
describe("GET /time-entries — read scoping", () => {
  const OTHER_ID = "55555555-5555-5555-5555-555555555555";

  /** The `where` the route actually handed Prisma. */
  function lastWhere(): Record<string, unknown> {
    const call = prisma.timeEntry.findMany.mock.calls.at(-1);
    return (call?.[0] as { where: Record<string, unknown> }).where;
  }

  function respondWith(rows: unknown[]) {
    prisma.timeEntry.findMany.mockResolvedValue(rows);
    prisma.timeEntry.count.mockResolvedValue(rows.length);
  }

  it("plain TIME_READ is pinned to the actor's own entries", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ")));
    respondWith([]);

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(200);
    expect(lastWhere().userId).toBe(ACTOR_ID);
  });

  it("TIME_READ cannot widen to another user by passing ?userId= (403, no query)", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ")));
    respondWith([]);

    const res = await GET(getRequest(`?userId=${OTHER_ID}`), { params });

    // A denial, not a silent narrowing: a caller that asked for someone else's
    // rows and received its own has been given a wrong answer, not a safe one.
    expect(res.status).toBe(403);
    expect(prisma.timeEntry.findMany).not.toHaveBeenCalled();
  });

  it("passing one's OWN userId is allowed and still scoped", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ")));
    respondWith([]);

    const res = await GET(getRequest(`?userId=${ACTOR_ID}`), { params });

    expect(res.status).toBe(200);
    expect(lastWhere().userId).toBe(ACTOR_ID);
  });

  it("TIME_READ_ALL sees the whole org (no userId filter)", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ", "TIME_READ_ALL")));
    respondWith([]);

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(200);
    expect(lastWhere().userId).toBeUndefined();
  });

  it("TIME_READ_ALL may narrow to a named user", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ", "TIME_READ_ALL")));
    respondWith([]);

    const res = await GET(getRequest(`?userId=${OTHER_ID}`), { params });

    expect(res.status).toBe(200);
    expect(lastWhere().userId).toBe(OTHER_ID);
  });

  it("?projectId= runs the team-aware gate and denies an invisible project", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ", "TIME_READ_ALL")));
    respondWith([]);
    // isProjectVisible: no such project (or another org's) → not visible.
    prisma.project.findFirst.mockResolvedValue(null);

    const res = await GET(
      getRequest("?projectId=66666666-6666-6666-6666-666666666666"),
      { params },
    );

    expect(res.status).toBe(403);
    expect(prisma.timeEntry.findMany).not.toHaveBeenCalled();
  });

  it("?projectId= on a visible project filters by it", async () => {
    const PROJECT_ID = "66666666-6666-6666-6666-666666666666";
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ", "TIME_READ_ALL")));
    respondWith([]);
    prisma.project.findFirst.mockResolvedValue({
      id: PROJECT_ID,
      teamScopedAccess: false,
    });

    const res = await GET(getRequest(`?projectId=${PROJECT_ID}`), { params });

    expect(res.status).toBe(200);
    expect(lastWhere().projectId).toBe(PROJECT_ID);
  });
});

/**
 * Rate visibility is a SEPARATE question from row visibility: a supervisor
 * approving hours needs the hours and has no business seeing the money, and
 * `rate` becomes cost rate — compensation data — once rate cards land.
 */
describe("GET /time-entries — rate redaction", () => {
  const OTHER_ID = "55555555-5555-5555-5555-555555555555";

  function rows() {
    return [
      { id: "mine", userId: ACTOR_ID, hours: 2, rate: "150" },
      { id: "theirs", userId: OTHER_ID, hours: 3, rate: "225" },
    ];
  }

  it("without FINANCE_READ, another user's rate is stripped but their row remains", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ", "TIME_READ_ALL")));
    prisma.timeEntry.findMany.mockResolvedValue(rows());
    prisma.timeEntry.count.mockResolvedValue(2);

    const body = await (await GET(getRequest(), { params })).json();

    expect(body.data).toHaveLength(2);
    expect(body.data.find((e: { id: string }) => e.id === "theirs").rate).toBeNull();
  });

  it("one's OWN rate is never redacted — the actor typed it", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ", "TIME_READ_ALL")));
    prisma.timeEntry.findMany.mockResolvedValue(rows());
    prisma.timeEntry.count.mockResolvedValue(2);

    const body = await (await GET(getRequest(), { params })).json();

    expect(body.data.find((e: { id: string }) => e.id === "mine").rate).toBe("150");
  });

  it("FINANCE_READ sees every rate", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith(bits("TIME_READ", "TIME_READ_ALL", "FINANCE_READ")),
    );
    prisma.timeEntry.findMany.mockResolvedValue(rows());
    prisma.timeEntry.count.mockResolvedValue(2);

    const body = await (await GET(getRequest(), { params })).json();

    expect(body.data.find((e: { id: string }) => e.id === "theirs").rate).toBe("225");
  });
});
