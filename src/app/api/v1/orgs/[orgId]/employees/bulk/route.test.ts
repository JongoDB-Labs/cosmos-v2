// @vitest-environment node
//
// POST /api/v1/orgs/[orgId]/employees/bulk — put many org members on payroll at
// once.
//
// The prisma mocks below are a tiny STATEFUL fake, not fixed return values, and
// that is the point. `orgMember.findMany` filters by the `where` it is handed,
// and `employee.createManyAndReturn` remembers what it has already inserted and
// honours `skipDuplicates` against it. A mock that answered the same thing
// regardless of the query would make "rejects non-members" and "is idempotent"
// both pass against code that did neither.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, logAudit } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    orgMember: { findMany: vi.fn() },
    employee: {
      createManyAndReturn: vi.fn(),
      // Present only so the tests can assert the route NEVER reads existing
      // employees before writing — idempotency has to come from the DB's unique
      // index, not from a read that a concurrent request can invalidate.
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    // Every new employee also gets their rate history opened, in the same call.
    employeeCostRate: { createMany: vi.fn() },
  },
  logAudit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));

import { POST } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const ACTOR = "44444444-4444-4444-8444-444444444444";
const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CARA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OUTSIDER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

// ── the stateful fake ────────────────────────────────────────────────────────
/** orgId → user ids that are members of it. */
const membersByOrg = new Map<string, Set<string>>();
/** orgId → user ids that already have an employee row. */
const employeesByOrg = new Map<string, Set<string>>();

type CreateRow = { orgId: string; userId: string; costRate: unknown; createdById: string };
/** Every row handed to createManyAndReturn, across the whole test. */
let inserted: CreateRow[] = [];

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}

function ctxWith(permissions: bigint): AuthContext {
  return {
    userId: ACTOR,
    orgId: ORG_ID,
    orgRole: OrgRole.ADMIN,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  };
}

const params = Promise.resolve({ orgId: ORG_ID });

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/orgs/o/employees/bulk", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  membersByOrg.clear();
  employeesByOrg.clear();
  inserted = [];

  membersByOrg.set(ORG_ID, new Set([ACTOR, ALICE, BOB, CARA]));
  // The outsider is a real person in a DIFFERENT tenant, which is the case that
  // matters: "unknown id" and "known id, wrong org" must fail identically.
  membersByOrg.set(OTHER_ORG, new Set([OUTSIDER]));

  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue(ctxWith(bits("FINANCE_MANAGE")));
  logAudit.mockResolvedValue(undefined);

  prisma.orgMember.findMany.mockImplementation(
    async ({ where }: { where: { orgId: string; userId?: { in: string[] } } }) => {
      const inOrg = membersByOrg.get(where.orgId) ?? new Set<string>();
      const asked = where.userId?.in ?? [...inOrg];
      return asked.filter((id) => inOrg.has(id)).map((userId) => ({ userId }));
    },
  );

  prisma.employee.createManyAndReturn.mockImplementation(
    async ({
      data,
      skipDuplicates,
    }: {
      data: CreateRow[];
      skipDuplicates?: boolean;
    }) => {
      const out: Array<{ id: string; userId: string }> = [];
      for (const row of data) {
        inserted.push(row);
        const have = employeesByOrg.get(row.orgId) ?? new Set<string>();
        if (have.has(row.userId)) {
          // Stands in for the [orgId, userId] unique index.
          if (!skipDuplicates) throw new Error("unique constraint violated");
          continue;
        }
        have.add(row.userId);
        employeesByOrg.set(row.orgId, have);
        out.push({ id: `emp-${row.userId}`, userId: row.userId });
      }
      return out;
    },
  );
});

describe("POST /employees/bulk — creating", () => {
  it("creates an employee record for every member sent, and reports the counts", async () => {
    const res = await POST(req({ userIds: [ALICE, BOB, CARA] }), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      created: 3,
      skipped: 0,
      createdUserIds: [ALICE, BOB, CARA],
    });
    expect(employeesByOrg.get(ORG_ID)).toEqual(new Set([ALICE, BOB, CARA]));
  });

  it("starts every new record on a cost rate of ZERO — never a guessed one", async () => {
    // A plausible-looking invented rate would mis-state labor expense and CLIN
    // burn with nothing downstream to flag it. Zero is visibly unset.
    await POST(req({ userIds: [ALICE, BOB] }), { params });

    expect(inserted).toHaveLength(2);
    for (const row of inserted) {
      expect(Number(row.costRate)).toBe(0);
      expect(row.orgId).toBe(ORG_ID);
      expect(row.createdById).toBe(ACTOR);
    }
  });

  it("de-duplicates repeated ids in one request", async () => {
    const res = await POST(req({ userIds: [ALICE, ALICE, BOB, ALICE] }), { params });
    const body = await res.json();

    expect(body.created).toBe(2);
    expect(body.createdUserIds).toEqual([ALICE, BOB]);
    expect(inserted.map((r) => r.userId)).toEqual([ALICE, BOB]);
  });
});

describe("POST /employees/bulk — idempotency", () => {
  it("re-running creates nothing and reports every id as skipped", async () => {
    await POST(req({ userIds: [ALICE, BOB] }), { params });
    inserted = [];

    const res = await POST(req({ userIds: [ALICE, BOB] }), { params });
    const body = await res.json();

    expect(body).toEqual({ created: 0, skipped: 2, createdUserIds: [] });
    // The row was still OFFERED to the database — the index rejected it. That
    // is the property under test: no read decided to withhold it.
    expect(inserted.map((r) => r.userId)).toEqual([ALICE, BOB]);
  });

  it("creates only the people who lack a record, and skips the rest", async () => {
    employeesByOrg.set(ORG_ID, new Set([ALICE]));

    const res = await POST(req({ userIds: [ALICE, BOB, CARA] }), { params });
    const body = await res.json();

    expect(body).toEqual({ created: 2, skipped: 1, createdUserIds: [BOB, CARA] });
  });

  it("opens a rate history for everyone it creates", async () => {
    // An employee row with no rate row resolves to no rate at all, so every hour
    // they log drops out of costing silently. The two writes belong together.
    await POST(req({ userIds: [ALICE, BOB] }), { params });

    expect(prisma.employeeCostRate.createMany).toHaveBeenCalledTimes(1);
    const { data } = prisma.employeeCostRate.createMany.mock.calls[0][0];
    expect(data).toHaveLength(2);
    expect(data.map((r: { employeeId: string }) => r.employeeId).sort()).toEqual(
      [`emp-${ALICE}`, `emp-${BOB}`].sort(),
    );
    // Floored, so an hour backdated before onboarding still resolves.
    for (const row of data) {
      expect(row.effectiveFrom.toISOString()).toBe("1970-01-01T00:00:00.000Z");
      expect(row.costRate.toString()).toBe("0");
    }
  });

  it("opens no rate history when everyone was already an employee", async () => {
    await POST(req({ userIds: [ALICE] }), { params });
    prisma.employeeCostRate.createMany.mockClear();

    await POST(req({ userIds: [ALICE] }), { params });
    expect(prisma.employeeCostRate.createMany).not.toHaveBeenCalled();
  });

  it("leans on the unique constraint — never reads existing employees first", async () => {
    // A read-then-write would let two admins clicking at once both decide the
    // row is absent. `ON CONFLICT DO NOTHING` cannot.
    await POST(req({ userIds: [ALICE, BOB] }), { params });

    expect(prisma.employee.createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(prisma.employee.findMany).not.toHaveBeenCalled();
    expect(prisma.employee.findFirst).not.toHaveBeenCalled();
    expect(prisma.employee.create).not.toHaveBeenCalled();
  });
});

describe("POST /employees/bulk — only org members", () => {
  it("rejects the WHOLE batch when one id is not a member of this org", async () => {
    const res = await POST(req({ userIds: [ALICE, OUTSIDER, BOB] }), { params });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "One of those people is not a member of this org",
    });
    // Nothing partially applied — the two genuine members did NOT get records.
    expect(prisma.employee.createManyAndReturn).not.toHaveBeenCalled();
    expect(employeesByOrg.get(ORG_ID)).toBeUndefined();
  });

  it("scopes the membership check to THIS org", async () => {
    // The outsider is a genuine member — of another tenant. The check has to
    // ask "member of this org", not "member of any org".
    await POST(req({ userIds: [OUTSIDER] }), { params });

    expect(prisma.orgMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orgId: ORG_ID }) }),
    );
  });
});

describe("POST /employees/bulk — audit", () => {
  it("writes ONE entry for the batch, carrying the created user ids", async () => {
    await POST(req({ userIds: [ALICE, BOB, CARA] }), { params });

    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        userId: ACTOR,
        action: "employee.bulk_created",
        entity: "employee",
        metadata: { userIds: [ALICE, BOB, CARA], skippedCount: 0 },
        ipAddress: "203.0.113.7",
      }),
    );
  });

  it("records only who was actually created, not who was skipped", async () => {
    employeesByOrg.set(ORG_ID, new Set([ALICE]));

    await POST(req({ userIds: [ALICE, BOB] }), { params });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { userIds: [BOB], skippedCount: 1 },
      }),
    );
  });

  it("writes NOTHING when the run created nobody", async () => {
    employeesByOrg.set(ORG_ID, new Set([ALICE, BOB]));

    await POST(req({ userIds: [ALICE, BOB] }), { params });

    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe("POST /employees/bulk — access", () => {
  it("allows FINANCE_MANAGE", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("FINANCE_MANAGE")));

    expect((await POST(req({ userIds: [ALICE] }), { params })).status).toBe(200);
  });

  it("allows ORG_MANAGE_MEMBERS — an HR admin without finance access", async () => {
    // Gating on FINANCE_MANAGE alone locks the people-admin out of the org
    // chart they are meant to run.
    getAuthContext.mockResolvedValue(ctxWith(bits("ORG_MANAGE_MEMBERS")));

    expect((await POST(req({ userIds: [ALICE] }), { params })).status).toBe(200);
  });

  it("403s with neither permission, and writes nothing", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("FINANCE_READ", "ORG_READ")));

    const res = await POST(req({ userIds: [ALICE] }), { params });

    expect(res.status).toBe(403);
    expect(prisma.employee.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("401s when signed out", async () => {
    getAuthContext.mockResolvedValue(null);

    expect((await POST(req({ userIds: [ALICE] }), { params })).status).toBe(401);
  });

  it("404s for an unknown org", async () => {
    prisma.organization.findUnique.mockResolvedValue(null);

    expect((await POST(req({ userIds: [ALICE] }), { params })).status).toBe(404);
  });
});

describe("POST /employees/bulk — input bounds", () => {
  it("400s past the batch cap, without touching the database", async () => {
    const tooMany = Array.from(
      { length: 201 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );

    const res = await POST(req({ userIds: tooMany }), { params });

    expect(res.status).toBe(400);
    expect(prisma.orgMember.findMany).not.toHaveBeenCalled();
    expect(prisma.employee.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("400s on an empty list", async () => {
    expect((await POST(req({ userIds: [] }), { params })).status).toBe(400);
  });

  it("400s when an id is not a uuid", async () => {
    expect((await POST(req({ userIds: ["not-a-uuid"] }), { params })).status).toBe(400);
  });
});
