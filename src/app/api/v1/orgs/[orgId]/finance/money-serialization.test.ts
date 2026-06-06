// @vitest-environment node
//
// Finance money-serialization invariant — locks the wire-shape contract that
// the Float→Decimal migration depends on:
//
//   • ENTITY endpoints (e.g. GET /finance/revenue) return raw Prisma rows via
//     success(). Prisma.Decimal.toJSON() serializes to a string, so `amount`
//     arrives on the wire as e.g. "100.5" (typeof === "string").
//
//   • AGGREGATE endpoints (e.g. GET /finance/summary) call moneyToNumber()
//     before emitting, so all money fields arrive as JS numbers.
//
// Two finance charts and all display code rely on this split; this test is the
// only route-level guard that the shape can't regress silently.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Prisma, OrgRole } from "@prisma/client";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

// ---------------------------------------------------------------------------
// Hoist mock objects so vi.mock() factories can close over them
// ---------------------------------------------------------------------------
const { getAuthContext, prisma, logAudit } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    revenue: { findMany: vi.fn(), count: vi.fn() },
    expense: { findMany: vi.fn() },
    timeEntry: { findMany: vi.fn() },
  },
  logAudit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));

// Route handlers imported AFTER mocks are registered
import { GET as revenueGET } from "./revenue/route";
import { GET as summaryGET } from "./summary/route";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const REVENUE_ID = "22222222-2222-4222-8222-222222222222";
const EXPENSE_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR_ID = "44444444-4444-4444-8444-444444444444";

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

function getRequest(path = "http://localhost/api/v1/orgs/o/finance/revenue"): NextRequest {
  return new NextRequest(path, { method: "GET" });
}

const params = Promise.resolve({ orgId: ORG_ID });

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue(ctxWith(bits("FINANCE_READ")));
  logAudit.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Finance money wire-shape invariant", () => {
  it("entity money (Revenue.amount) serializes as a STRING on the wire", async () => {
    // Construct a row with a REAL Prisma.Decimal — this exercises the actual
    // Prisma.Decimal.toJSON() → string path that NextResponse.json() traverses.
    prisma.revenue.findMany.mockResolvedValue([
      {
        id: REVENUE_ID,
        orgId: ORG_ID,
        amount: new Prisma.Decimal("100.50"),
        currency: "USD",
        date: new Date("2026-01-15"),
        client: null,
        product: null,
        type: "ONE_TIME",
        description: "",
        createdById: ACTOR_ID,
        createdAt: new Date("2026-01-15"),
        updatedAt: new Date("2026-01-15"),
      },
    ]);
    prisma.revenue.count.mockResolvedValue(1);

    const res = await revenueGET(getRequest(), { params });
    expect(res.status).toBe(200);

    const body = await res.json();
    // The response envelope is { data: [...], total: n }
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.total).toBe(1);

    const amount = body.data[0].amount;

    // Core invariant: Prisma.Decimal serializes to a string via toJSON()
    expect(typeof amount).toBe("string");
    // And the numeric value must be correct (robust to trailing-zero formatting)
    expect(Number(amount)).toBe(100.5);
  });

  it("summary aggregates (totalRevenue, totalExpenses, netIncome) serialize as NUMBERS", async () => {
    // Two revenue rows: 100.50 + 200.25 = 300.75
    prisma.revenue.findMany.mockResolvedValue([
      {
        id: REVENUE_ID,
        orgId: ORG_ID,
        amount: new Prisma.Decimal("100.50"),
        currency: "USD",
        date: new Date("2026-01-15"),
        type: "ONE_TIME",
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        orgId: ORG_ID,
        amount: new Prisma.Decimal("200.25"),
        currency: "USD",
        date: new Date("2026-02-10"),
        type: "RECURRING",
      },
    ]);
    // One expense row: 50.25
    prisma.expense.findMany.mockResolvedValue([
      {
        id: EXPENSE_ID,
        orgId: ORG_ID,
        amount: new Prisma.Decimal("50.25"),
        currency: "USD",
        date: new Date("2026-01-20"),
        category: "software",
        status: "APPROVED",
        createdById: ACTOR_ID,
        createdAt: new Date("2026-01-20"),
        updatedAt: new Date("2026-01-20"),
      },
    ]);
    // No time entries
    prisma.timeEntry.findMany.mockResolvedValue([]);

    const res = await summaryGET(
      getRequest("http://localhost/api/v1/orgs/o/finance/summary"),
      { params },
    );
    expect(res.status).toBe(200);

    const body = await res.json();

    // Core invariant: aggregate money must come back as JS numbers (not strings)
    expect(typeof body.totalRevenue).toBe("number");
    expect(body.totalRevenue).toBe(300.75);

    expect(typeof body.totalExpenses).toBe("number");
    expect(body.totalExpenses).toBe(50.25);

    expect(typeof body.netIncome).toBe("number");
    expect(body.netIncome).toBe(250.5);
  });
});
