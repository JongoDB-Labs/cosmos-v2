// @vitest-environment node
//
// The finance tiles read "Total Revenue $0.00 · Total Expenses $0.00 · Net
// Income $0.00" for an org that had never opened the accounting module — while
// the project table on the same page counted its work at $1,039,168. Zero is a
// claim about what the practice took, and nothing in the data supported it.
//
// The distinction is invisible inside a date window: a firm that keeps its
// books and had a quiet month genuinely earned zero and should see $0.00. So
// the question is not "are there rows in this window" but "has this org ever
// posted at all".
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import { OrgRole } from "@prisma/client";

const { getAuthContext, requirePermission, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  requirePermission: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    revenue: { findMany: vi.fn(), count: vi.fn() },
    expense: { findMany: vi.fn(), count: vi.fn() },
    timeEntry: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/rbac/check", () => ({ requirePermission }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { GET } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ orgId: ORG_ID });
const req = () => new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/finance/summary`);

async function body(res: Response) {
  const b = await res.json();
  return b.data ?? b;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue({
    userId: "44444444-4444-4444-8444-444444444444",
    orgId: ORG_ID,
    orgRole: OrgRole.OWNER,
    permissions: Permission.FINANCE_READ,
    basePermissions: Permission.FINANCE_READ,
    abacRules: [],
  });
  prisma.revenue.findMany.mockResolvedValue([]);
  prisma.expense.findMany.mockResolvedValue([]);
  prisma.timeEntry.findMany.mockResolvedValue([]);
});

describe("finance summary — an unused ledger", () => {
  it("withholds the totals when the org has never posted", async () => {
    prisma.revenue.count.mockResolvedValue(0);
    prisma.expense.count.mockResolvedValue(0);
    const b = await body(await GET(req(), { params }));
    expect(b.totalRevenue).toBeNull();
    expect(b.totalExpenses).toBeNull();
    expect(b.netIncome).toBeNull();
  });

  it("reports a real zero for a quiet month on books that are in use", async () => {
    // Nothing in the window, but the ledger has rows elsewhere: the firm did
    // earn zero this month, and saying so is the point of the figure.
    prisma.revenue.count.mockResolvedValue(12);
    prisma.expense.count.mockResolvedValue(3);
    const b = await body(await GET(req(), { params }));
    expect(b.totalRevenue).toBe(0);
    expect(b.netIncome).toBe(0);
  });

  it("one posting anywhere is enough to make the books readable", async () => {
    prisma.revenue.count.mockResolvedValue(0);
    prisma.expense.count.mockResolvedValue(1);
    expect((await body(await GET(req(), { params }))).totalRevenue).toBe(0);
  });
});

describe("finance summary — recorded time", () => {
  it("counts submitted as well as approved hours", async () => {
    prisma.revenue.count.mockResolvedValue(0);
    prisma.expense.count.mockResolvedValue(0);
    await GET(req(), { params });
    const where = prisma.timeEntry.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ["SUBMITTED", "APPROVED"] });
    expect(where.voidedAt).toBeNull();
  });
});
