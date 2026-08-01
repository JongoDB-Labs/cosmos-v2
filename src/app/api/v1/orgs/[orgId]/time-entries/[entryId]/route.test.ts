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
    timeEntry: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    employee: { findMany: vi.fn() },
    timesheet: { findUnique: vi.fn(), upsert: vi.fn() },
    timeEntryRevision: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

import { GET, DELETE } from "./route";

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
    prisma.employee.findMany.mockResolvedValue([]);
    prisma.timeEntry.findFirst.mockResolvedValue(null);

    await GET(getRequest(), { params });

    expect(lastWhere().userId).toEqual({ in: [ACTOR_ID] });
  });

  it("another user's entry is a 404, indistinguishable from one that never existed", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ")));
    prisma.employee.findMany.mockResolvedValue([]);
    // The mock HONOURS the where-clause rather than returning a fixed null.
    // Hard-coding null would pass whether or not the route scoped the query —
    // it would assert "null yields 404", which was never in doubt. Filtering
    // for real is what makes this a guard: drop the owner constraint and the
    // row comes back with a 200.
    prisma.timeEntry.findFirst.mockImplementation(
      ({ where }: { where: { userId?: { in: string[] } } }) => {
        const row = { id: ENTRY_ID, userId: OTHER_ID, rate: "225" };
        const allowed = where.userId?.in;
        return Promise.resolve(allowed && !allowed.includes(row.userId) ? null : row);
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
    prisma.employee.findMany.mockResolvedValue([]);
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

/**
 * Delete became VOID. Hard deletion makes a timekeeping dataset inadmissible —
 * an auditor cannot distinguish "never entered" from "removed after the fact" —
 * so the row and its hours are retained and every read filters them out.
 *
 * The caller sees exactly what a delete looked like (204, entry gone from
 * lists), which is why these assert the DATABASE CALL rather than the response:
 * a response-only test passes identically against a real delete.
 */
describe("DELETE /time-entries/[entryId] — voids, never deletes", () => {
  const DRAFT_ENTRY = {
    id: ENTRY_ID,
    userId: ACTOR_ID,
    orgId: ORG_ID,
    status: "DRAFT",
    hours: 8,
    timesheetId: "ts-1",
  };

  /** The `data` of the most recent update() call. Typed so `tsc` is satisfied
   *  without scattering non-null assertions through the assertions. */
  function lastUpdateData(): Record<string, unknown> {
    const call = prisma.timeEntry.update.mock.calls.at(-1);
    if (!call) throw new Error("timeEntry.update was never called");
    return (call[0] as { data: Record<string, unknown> }).data;
  }

  function lastRevisionData(): Record<string, unknown> {
    const call = prisma.timeEntryRevision.create.mock.calls.at(-1);
    if (!call) throw new Error("timeEntryRevision.create was never called");
    return (call[0] as { data: Record<string, unknown> }).data;
  }

  function deleteRequest(body?: unknown): NextRequest {
    return new NextRequest(
      `http://localhost/api/v1/orgs/o/time-entries/${ENTRY_ID}`,
      body === undefined
        ? { method: "DELETE" }
        : {
            method: "DELETE",
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
          },
    );
  }

  beforeEach(() => {
    getAuthContext.mockResolvedValue(
      ctxWith(bits("TIME_READ", "TIME_DELETE")),
    );
    prisma.timeEntry.findFirst.mockResolvedValue(DRAFT_ENTRY);
    prisma.timeEntry.update.mockResolvedValue({ ...DRAFT_ENTRY, voidedAt: new Date() });
    prisma.timesheet.findUnique.mockResolvedValue({ status: "OPEN" });
  });

  it("never calls delete()", async () => {
    await DELETE(deleteRequest({ reason: "duplicate entry" }), { params });

    expect(prisma.timeEntry.delete).not.toHaveBeenCalled();
  });

  it("stamps voidedAt and who did it", async () => {
    await DELETE(deleteRequest({ reason: "duplicate entry" }), { params });

    const data = lastUpdateData();
    expect(data.voidedAt).toBeInstanceOf(Date);
    expect(data.voidedById).toBe(ACTOR_ID);
  });

  it("still answers 204 once a reason is given", async () => {
    const res = await DELETE(deleteRequest({ reason: "duplicate entry" }), {
      params,
    });

    expect(res.status).toBe(204);
  });

  it("REFUSES a removal with no reason", async () => {
    // Recorded hours price a CLIN and can reach an invoice, so a removal
    // nobody can explain is exactly what an audit finds. Enforcing it only in
    // the dialog is not a control — anything calling the API directly skips it.
    const res = await DELETE(deleteRequest(), { params });

    expect(res.status).toBe(400);
    expect(prisma.timeEntry.update).not.toHaveBeenCalled();
  });

  it("REFUSES a blank reason", async () => {
    const res = await DELETE(deleteRequest({ reason: "   " }), { params });

    expect(res.status).toBe(400);
    expect(prisma.timeEntry.update).not.toHaveBeenCalled();
  });

  it("records the reason it was given", async () => {
    await DELETE(deleteRequest({ reason: "logged against the wrong project" }), {
      params,
    });

    expect(lastUpdateData().voidReason).toBe("logged against the wrong project");
  });

  it("writes a revision recording the void", async () => {
    await DELETE(deleteRequest({ reason: "duplicate" }), { params });

    expect(prisma.timeEntryRevision.create).toHaveBeenCalled();
    const rev = lastRevisionData();
    expect(rev.reason).toBe("duplicate");
    expect(rev.actorId).toBe(ACTOR_ID);
  });

  it("an ALREADY-voided entry is a 404, not a second void", async () => {
    // The mock HONOURS the where-clause. A fixed null would pass whether or not
    // the route filtered `voidedAt: null` — it would only assert "null yields
    // 404", which was never in doubt. Here the row EXISTS and is voided, so
    // only a route that actually filters gets nothing back.
    const alreadyVoided = { ...DRAFT_ENTRY, voidedAt: new Date("2026-07-01") };
    prisma.timeEntry.findFirst.mockImplementation(
      ({ where }: { where: { voidedAt?: null } }) =>
        Promise.resolve(
          where.voidedAt === null && alreadyVoided.voidedAt !== null
            ? null
            : alreadyVoided,
        ),
    );

    const res = await DELETE(deleteRequest(), { params });

    expect(res.status).toBe(404);
    expect(prisma.timeEntry.update).not.toHaveBeenCalled();
  });
});
