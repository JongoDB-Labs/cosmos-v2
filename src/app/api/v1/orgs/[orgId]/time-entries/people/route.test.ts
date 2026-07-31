// @vitest-environment node
//
// The person picker's data source. This endpoint exists because widening the
// read scope broke the time page's arithmetic: its week grid sums every row it
// receives, so a response mixing several people silently turns "your week
// total" into their hours added together. The page views ONE person at a time,
// and this says who may be picked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    employee: { findMany: vi.fn() },
    orgMember: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { GET } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR = "44444444-4444-4444-4444-444444444444";
const REPORT = "55555555-5555-5555-5555-555555555555";

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}
function ctxWith(permissions: bigint): AuthContext {
  return {
    userId: ACTOR,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  };
}
const params = Promise.resolve({ orgId: ORG_ID });
const req = () =>
  new NextRequest("http://localhost/api/v1/orgs/o/time-entries/people");

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
});

describe("GET /time-entries/people", () => {
  it("a plain member gets only themselves", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ")));
    prisma.employee.findMany.mockResolvedValue([]);
    prisma.orgMember.findMany.mockResolvedValue([
      { userId: ACTOR, user: { displayName: "Me" } },
    ]);

    const body = await (await GET(req(), { params })).json();

    expect(body.data).toEqual([
      { userId: ACTOR, displayName: "Me", isSelf: true },
    ]);
    // One person means the client renders no picker at all.
    expect(body.total).toBe(1);
  });

  it("a supervisor gets themselves plus their reports, self FIRST", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ")));
    prisma.employee.findMany.mockResolvedValue([
      { userId: ACTOR },
      { userId: REPORT },
    ]);
    // Returned in an order that does NOT put the actor first, so the sort has
    // to do real work — the page defaults to "my time" and a picker whose first
    // option is somebody else invites picking the wrong one.
    prisma.orgMember.findMany.mockResolvedValue([
      { userId: REPORT, user: { displayName: "Aaron" } },
      { userId: ACTOR, user: { displayName: "Zoe" } },
    ]);

    const body = await (await GET(req(), { params })).json();

    expect(body.data.map((p: { userId: string }) => p.userId)).toEqual([
      ACTOR,
      REPORT,
    ]);
    expect(body.data[0].isSelf).toBe(true);
    expect(body.data[1].isSelf).toBe(false);
  });

  it("restricts the member lookup to the readable set", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ")));
    prisma.employee.findMany.mockResolvedValue([{ userId: ACTOR }]);
    prisma.orgMember.findMany.mockResolvedValue([]);

    await GET(req(), { params });

    const where = prisma.orgMember.findMany.mock.calls[0][0].where;
    expect(where.orgId).toBe(ORG_ID);
    expect(where.userId).toEqual({ in: [ACTOR] });
  });

  it("TIME_READ_ALL gets the whole org — no userId restriction", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ", "TIME_READ_ALL")));
    prisma.orgMember.findMany.mockResolvedValue([
      { userId: ACTOR, user: { displayName: "Me" } },
    ]);

    await GET(req(), { params });

    const where = prisma.orgMember.findMany.mock.calls[0][0].where;
    expect(where.userId).toBeUndefined();
  });

  it("without TIME_READ → 403, and never queries", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("ORG_READ")));

    const res = await GET(req(), { params });

    expect(res.status).toBe(403);
    expect(prisma.orgMember.findMany).not.toHaveBeenCalled();
  });
});
