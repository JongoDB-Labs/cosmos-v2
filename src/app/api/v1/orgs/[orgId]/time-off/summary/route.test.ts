// @vitest-environment node
//
// Time-off balances, RBAC-gated through the real time read scope: a member
// sees only their own row, a supervisor adds their reports, and only org-wide
// time access sees everyone. Who is asked about is decided BEFORE any leave is
// fetched, so the query itself never names someone the caller can't read.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    orgMember: { findMany: vi.fn() },
    employee: { findMany: vi.fn() },
    timesheet: { findMany: vi.fn() },
    timeOffRequest: { findMany: vi.fn() },
    timeOffAllowance: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { GET } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ME = "44444444-4444-4444-8444-444444444444";
const REPORT = "55555555-5555-4555-8555-555555555555";
const STRANGER = "66666666-6666-4666-8666-666666666666";
const params = Promise.resolve({ orgId: ORG_ID });

const ctx = (role: "MEMBER" | "ADMIN", extra = 0n): AuthContext => ({
  userId: ME,
  orgId: ORG_ID,
  orgRole: OrgRole[role],
  permissions: RolePermissions[role] | extra,
  basePermissions: RolePermissions[role] | extra,
  abacRules: [],
});

const MEMBERS = [
  { userId: ME, user: { displayName: "Me" } },
  { userId: REPORT, user: { displayName: "Report" } },
  { userId: STRANGER, user: { displayName: "Stranger" } },
];

const get = (qs = "?year=2026") => GET(new NextRequest(`http://localhost/x${qs}`), { params });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({
    id: ORG_ID,
    slug: "acme",
    settings: { time: { timeOff: { annualAllowanceHours: 120 } } },
  });
  // The roster query is narrowed by the scope; honour its `in` like Postgres would.
  prisma.orgMember.findMany.mockImplementation(async ({ where }: { where: { userId?: { in: string[] } } }) =>
    MEMBERS.filter((m) => !where.userId || where.userId.in.includes(m.userId)),
  );
  prisma.employee.findMany.mockResolvedValue([]);
  prisma.timesheet.findMany.mockResolvedValue([]);
  prisma.timeOffRequest.findMany.mockResolvedValue([
    {
      userId: ME,
      kind: "VACATION",
      status: "APPROVED",
      startDate: new Date("2025-03-03T00:00:00Z"), // Mon–Fri of a past year's week, so "used" is fixed
      endDate: new Date("2025-03-07T00:00:00Z"),
      hoursPerDay: 8,
    },
  ]);
  prisma.timeOffAllowance.findMany.mockResolvedValue([]);
});

const asked = () => prisma.timeOffRequest.findMany.mock.calls[0][0].where.userId.in as string[];

describe("GET /time-off/summary", () => {
  it("a member gets their own row only, and the leave query names only them", async () => {
    getAuthContext.mockResolvedValue(ctx("MEMBER"));
    const res = await get("?year=2025");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows.map((r: { userId: string }) => r.userId)).toEqual([ME]);
    expect(asked()).toEqual([ME]);
    expect(body.rows[0]).toMatchObject({ used: 40, allowance: 120, allowanceSource: "org", remaining: 80 });
    expect(body.canManage).toBe(false);
  });

  it("a supervisor also gets their reports, and nobody else", async () => {
    getAuthContext.mockResolvedValue(ctx("MEMBER"));
    prisma.employee.findMany.mockResolvedValue([{ userId: ME }, { userId: REPORT }]);
    const body = await (await get()).json();
    expect(body.rows.map((r: { userId: string }) => r.userId).sort()).toEqual([ME, REPORT].sort());
    expect(asked()).not.toContain(STRANGER);
  });

  it("org-wide time access sees everyone, and an admin may manage allowances", async () => {
    getAuthContext.mockResolvedValue(ctx("ADMIN"));
    const body = await (await get()).json();
    expect(body.rows).toHaveLength(3);
    expect(body.canManage).toBe(true);
  });

  it("a person's own allowance wins over the org default", async () => {
    getAuthContext.mockResolvedValue(ctx("MEMBER"));
    prisma.timeOffAllowance.findMany.mockResolvedValue([{ userId: ME, hours: 200 }]);
    const body = await (await get("?year=2025")).json();
    expect(body.rows[0]).toMatchObject({ allowance: 200, allowanceSource: "person", remaining: 160 });
  });

  it("asks only for counted kinds, in live statuses, overlapping the year", async () => {
    getAuthContext.mockResolvedValue(ctx("MEMBER"));
    await get();
    expect(prisma.timeOffRequest.findMany.mock.calls[0][0].where).toMatchObject({
      orgId: ORG_ID,
      kind: { in: ["VACATION"] },
      status: { in: ["PENDING", "APPROVED"] },
      startDate: { lte: new Date("2026-12-31T00:00:00.000Z") },
      endDate: { gte: new Date("2026-01-01T00:00:00.000Z") },
    });
  });

  it("without TIME_READ: 403, and no leave is read", async () => {
    getAuthContext.mockResolvedValue({ ...ctx("MEMBER"), permissions: Permission.PROJECT_READ, basePermissions: Permission.PROJECT_READ });
    const res = await get();
    expect(res.status).toBe(403);
    expect(prisma.timeOffRequest.findMany).not.toHaveBeenCalled();
  });

  it("an out-of-range year is a 400", async () => {
    getAuthContext.mockResolvedValue(ctx("MEMBER"));
    expect((await get("?year=1066")).status).toBe(400);
  });
});
