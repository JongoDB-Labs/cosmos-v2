import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { prisma, getAuthContext, readableTimeUserIds } = vi.hoisted(() => ({
  prisma: {
    organization: { findUnique: vi.fn() },
    timesheet: { findMany: vi.fn() },
    timeEntry: { findMany: vi.fn() },
  },
  getAuthContext: vi.fn(),
  readableTimeUserIds: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/time/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/time/scope")>();
  return { ...actual, readableTimeUserIds: (...a: unknown[]) => readableTimeUserIds(...a) };
});

import { GET } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ME = "44444444-4444-4444-4444-444444444444";
const SOMEBODY_ELSE = "55555555-5555-5555-5555-555555555555";

const bits = (...keys: PermissionKey[]) => keys.reduce((a, k) => a | Permission[k], 0n);

function ctx(): AuthContext {
  const permissions = bits("TIME_READ");
  return {
    userId: ME,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  } as AuthContext;
}

const req = (qs: string) =>
  new NextRequest(`http://localhost/api/v1/orgs/o/timesheets/periods${qs}`);
const params = Promise.resolve({ orgId: ORG_ID });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "o" });
  getAuthContext.mockResolvedValue(ctx());
  readableTimeUserIds.mockResolvedValue(null); // null = may read everybody
  prisma.timesheet.findMany.mockResolvedValue([]);
  prisma.timeEntry.findMany.mockResolvedValue([]);
});

const body = async (r: Response) => {
  const j = await r.json();
  return (j.data ?? j) as { start: string; end: string; status: string; hours: number }[];
};

describe("GET timesheets/periods", () => {
  it("covers the whole year, starting with the period that contains 1 January", async () => {
    // 2026-01-01 is a Thursday, so the first row starts on 2025-12-29. A period
    // belongs to the year its Monday falls in everywhere else in this codebase,
    // and slicing it differently here would disagree with the cheque.
    const rows = await body(await GET(req("?year=2026"), { params }));
    expect(rows[0].start).toBe("2025-12-29");
    expect(rows.at(-1)!.end >= "2026-12-31").toBe(true);
    expect(rows).toHaveLength(53);
  });

  it("gives a period with no timesheet a row anyway", async () => {
    // The point of the screen: a list of only the sheets that exist cannot show
    // the week somebody forgot.
    const rows = await body(await GET(req("?year=2026"), { params }));
    expect(rows.every((r) => r.status === "OPEN")).toBe(true);
    expect(rows.every((r) => r.hours === 0)).toBe(true);
  });

  it("totals hours from the entries, not from the sheet", async () => {
    prisma.timeEntry.findMany.mockResolvedValue([
      { date: new Date("2026-03-02T00:00:00.000Z"), hours: 6 },
      { date: new Date("2026-03-04T00:00:00.000Z"), hours: 2.5 },
      { date: new Date("2026-03-10T00:00:00.000Z"), hours: 1 },
    ]);
    const rows = await body(await GET(req("?year=2026"), { params }));
    expect(rows.find((r) => r.start === "2026-03-02")!.hours).toBe(8.5);
    expect(rows.find((r) => r.start === "2026-03-09")!.hours).toBe(1);
  });

  it("carries the status of a period that does have a sheet", async () => {
    prisma.timesheet.findMany.mockResolvedValue([
      {
        periodStart: new Date("2026-03-02T00:00:00.000Z"),
        status: "APPROVED",
        submittedAt: new Date("2026-03-09T09:00:00.000Z"),
        updatedAt: new Date("2026-03-10T09:00:00.000Z"),
      },
    ]);
    const rows = await body(await GET(req("?year=2026"), { params }));
    expect(rows.find((r) => r.start === "2026-03-02")!.status).toBe("APPROVED");
  });

  it("refuses somebody else's year when their hours are not readable", async () => {
    // Refused, not returned empty: an empty year reads as "they worked nothing"
    // rather than "that is not yours to see".
    readableTimeUserIds.mockResolvedValue([ME]);
    const res = await GET(req(`?year=2026&userId=${SOMEBODY_ELSE}`), { params });
    expect(res.status).toBe(403);
    expect(prisma.timesheet.findMany).not.toHaveBeenCalled();
  });

  it("allows somebody else's year when it is readable", async () => {
    readableTimeUserIds.mockResolvedValue([ME, SOMEBODY_ELSE]);
    const res = await GET(req(`?year=2026&userId=${SOMEBODY_ELSE}`), { params });
    expect(res.status).toBe(200);
    expect(prisma.timesheet.findMany.mock.calls[0][0].where.userId).toBe(SOMEBODY_ELSE);
  });

  it("needs a plausible year", async () => {
    for (const qs of ["", "?year=", "?year=abc", "?year=99"]) {
      expect((await GET(req(qs), { params })).status).toBe(400);
    }
  });
});
