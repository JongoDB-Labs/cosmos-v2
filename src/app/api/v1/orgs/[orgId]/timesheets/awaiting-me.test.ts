// @vitest-environment node
//
// `GET /timesheets?awaitingMe=1` — the approver's queue.
//
// The security property is that it NARROWS. It is an accelerator over a set the
// caller could already read, so it must compose with `readableTimeUserIds`
// rather than replace it: a filter that widened the scope would hand any
// approver every timesheet in the org.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, readableTimeUserIds, timeUserIdFilter } =
  vi.hoisted(() => ({
    getAuthContext: vi.fn(),
    prisma: {
      organization: { findUnique: vi.fn() },
      timesheet: { findMany: vi.fn() },
      user: { findMany: vi.fn() },
    },
    readableTimeUserIds: vi.fn(),
    timeUserIdFilter: vi.fn(),
  }));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/time/scope", () => ({ readableTimeUserIds, timeUserIdFilter }));

import { GET } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ME = "44444444-4444-4444-4444-444444444444";
const ALICE = "55555555-5555-5555-5555-555555555555";

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}
const ctx: AuthContext = {
  userId: ME,
  orgId: ORG_ID,
  orgRole: OrgRole.MEMBER,
  permissions: bits("TIME_READ"),
  basePermissions: bits("TIME_READ"),
  abacRules: [],
};
const params = Promise.resolve({ orgId: ORG_ID });
const req = (qs = "") =>
  new NextRequest(`http://localhost/api/v1/orgs/o/timesheets${qs}`);

/** The `where` the route actually handed Prisma. */
const lastWhere = () =>
  prisma.timesheet.findMany.mock.calls.at(-1)?.[0]?.where as Record<
    string,
    unknown
  >;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue(ctx);
  readableTimeUserIds.mockResolvedValue([ME, ALICE]);
  timeUserIdFilter.mockReturnValue({ in: [ME, ALICE] });
  prisma.timesheet.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
});

describe("GET /timesheets?awaitingMe=1", () => {
  it("filters to sheets ROUTED TO ME", async () => {
    await GET(req("?awaitingMe=1"), { params });

    // The routing stamp, not authority. Authority is a wider set, and using it
    // would fill an admin's queue with weeks somebody else was asked to handle.
    expect(lastWhere().approverIds).toEqual({ has: ME });
  });

  it("still applies the readable-time scope — it NARROWS, never widens", async () => {
    // The assertion that matters. A queue that replaced the scope filter would
    // expose every timesheet in the org to anyone stamped on any sheet.
    await GET(req("?awaitingMe=1"), { params });

    expect(readableTimeUserIds).toHaveBeenCalled();
    expect(lastWhere().userId).toEqual({ in: [ME, ALICE] });
  });

  it("returns only weeks that still OWE a decision", async () => {
    // An approved or returned week is waiting on nobody. Leaving it here makes
    // the queue permanently non-empty, which trains people to ignore it.
    await GET(req("?awaitingMe=1"), { params });

    expect(lastWhere().status).toEqual({
      in: ["SUBMITTED", "LABOR_APPROVED"],
    });
  });

  it("overrides an explicit status, rather than being escapable by one", async () => {
    // `?awaitingMe=1&status=APPROVED` must not surface approved weeks: the
    // widening in `readableTimeUserIds` is bounded to sheets awaiting a
    // decision, so anything else would read outside it.
    await GET(req("?awaitingMe=1&status=APPROVED"), { params });

    expect(lastWhere().status).toEqual({
      in: ["SUBMITTED", "LABOR_APPROVED"],
    });
  });

  it("does NOT filter by approver when the flag is absent", async () => {
    // The ordinary listing still backs the person picker and the week's status.
    await GET(req(), { params });

    expect(lastWhere().approverIds).toBeUndefined();
  });

  it("ignores a value that is not exactly 1", async () => {
    // An explicit opt-in, so a stray `awaitingMe=0` cannot silently re-scope
    // the page.
    await GET(req("?awaitingMe=0"), { params });

    expect(lastWhere().approverIds).toBeUndefined();
  });

  it("still requires TIME_READ", async () => {
    getAuthContext.mockResolvedValue({ ...ctx, permissions: 0n });

    const res = await GET(req("?awaitingMe=1"), { params });

    expect(res.status).toBe(403);
  });

  it("401s when signed out", async () => {
    getAuthContext.mockResolvedValue(null);

    expect((await GET(req("?awaitingMe=1"), { params })).status).toBe(401);
  });
});
