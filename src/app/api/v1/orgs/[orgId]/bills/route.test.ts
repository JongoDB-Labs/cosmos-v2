import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    organization: { findUnique: vi.fn() },
    bill: { findMany: vi.fn(), create: vi.fn() },
  },
}));
const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { GET, POST } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

const bits = (...k: PermissionKey[]) => k.reduce((a, x) => a | Permission[x], 0n);
const ctx = (...k: PermissionKey[]): AuthContext => {
  const permissions = bits(...k);
  return {
    userId: ME,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  } as AuthContext;
};

const row = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  reference: "INV-77",
  vendorName: "Reed Structural",
  partnerId: null,
  projectId: PROJECT,
  invoiceId: null,
  status: "OPEN",
  terms: "DUE_DATE",
  issueDate: new Date("2026-09-01T00:00:00.000Z"),
  dueDate: new Date("2026-09-10T00:00:00.000Z"),
  paidDate: null,
  currency: "USD",
  amount: 1000,
  amountPaid: 0,
  notes: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  project: { key: "P1", name: "A job" },
  partner: null,
  invoice: null,
  ...over,
});

const req = (qs = "") => new NextRequest(`http://localhost/api/v1/orgs/o/bills${qs}`);
const post = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/orgs/o/bills", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const params = Promise.resolve({ orgId: ORG_ID });
/**
 * This route's payload is `{data, totals, today}` -- three keys, so it is NOT
 * an envelope and must not be unwrapped. A generic `j.data ?? j` helper reads
 * the rows and silently loses the summary, which is exactly what it did here.
 */
const body = async (r: Response) => await r.json();

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "o" });
  getAuthContext.mockResolvedValue(ctx("FINANCE_READ", "FINANCE_MANAGE"));
  prisma.bill.findMany.mockResolvedValue([]);
});

describe("GET /orgs/[orgId]/bills", () => {
  it("returns the summary alongside the rows", async () => {
    prisma.bill.findMany.mockResolvedValue([row()]);
    const payload = await body(await GET(req(), { params }));
    expect(payload.totals.total).toBe(1000);
    expect(payload.data).toHaveLength(1);
  });

  it("computes the summary over the same set the filter selected", async () => {
    // The screen's four figures have to describe the rows under them; a
    // client-side sum of a filtered page would not.
    prisma.bill.findMany.mockResolvedValue([row({ amount: 400, amountPaid: 400, status: "PAID" })]);
    const payload = await body(await GET(req("?status=PAID"), { params }));
    expect(prisma.bill.findMany.mock.calls[0][0].where.status).toBe("PAID");
    expect(payload.totals.paid).toBe(400);
    expect(payload.totals.owed).toBe(0);
  });

  it("ignores a status that is not a status", async () => {
    await GET(req("?status=;DROP"), { params });
    expect(prisma.bill.findMany.mock.calls[0][0].where.status).toBeUndefined();
  });

  it("can ask for only the bills with no client invoice behind them", async () => {
    await GET(req("?invoice=none"), { params });
    expect(prisma.bill.findMany.mock.calls[0][0].where.invoiceId).toBeNull();
  });

  it("serialises money as numbers, not Decimals", async () => {
    prisma.bill.findMany.mockResolvedValue([row()]);
    const payload = await body(await GET(req(), { params }));
    expect(typeof payload.data[0].amount).toBe("number");
    expect(payload.data[0].dueDate).toBe("2026-09-10");
  });

  it("refuses a reader without finance access", async () => {
    getAuthContext.mockResolvedValue(ctx("ORG_READ"));
    expect((await GET(req(), { params })).status).toBe(403);
    expect(prisma.bill.findMany).not.toHaveBeenCalled();
  });
});

describe("POST /orgs/[orgId]/bills", () => {
  const input = { reference: "INV-77", vendorName: "Reed Structural", amount: 1000 };

  it("records a bill as owed by default", async () => {
    prisma.bill.create.mockResolvedValue(row());
    const res = await POST(post(input), { params });
    expect(res.status).toBe(201);
    expect(prisma.bill.create.mock.calls[0][0].data).toMatchObject({
      orgId: ORG_ID,
      status: "OPEN",
      terms: "DUE_DATE",
      createdById: ME,
    });
  });

  it("gives a pay-when-paid bill no due date at all", async () => {
    // Keeping one would leave a date every later screen has to remember to
    // ignore, which is how a bill nobody owes ends up in red.
    prisma.bill.create.mockResolvedValue(row({ terms: "PAY_WHEN_PAID", dueDate: null }));
    await POST(post({ ...input, terms: "PAY_WHEN_PAID", dueDate: "2026-10-01" }), { params });
    expect(prisma.bill.create.mock.calls[0][0].data.dueDate).toBeNull();
  });

  it("keeps the due date on ordinary terms", async () => {
    prisma.bill.create.mockResolvedValue(row());
    await POST(post({ ...input, dueDate: "2026-10-01" }), { params });
    expect(prisma.bill.create.mock.calls[0][0].data.dueDate).toEqual(
      new Date("2026-10-01T00:00:00.000Z"),
    );
  });

  it("refuses somebody who may read finance but not change it", async () => {
    getAuthContext.mockResolvedValue(ctx("FINANCE_READ"));
    expect((await POST(post(input), { params })).status).toBe(403);
    expect(prisma.bill.create).not.toHaveBeenCalled();
  });

  it("rejects a bill with no vendor", async () => {
    const res = await POST(post({ ...input, vendorName: "" }), { params });
    expect(res.status).toBe(400);
    expect(prisma.bill.create).not.toHaveBeenCalled();
  });
});
