// @vitest-environment node
//
// Bills under a team-scoped project are that team's, as that project's invoices
// and expenses already are: the list leaves them out for anyone outside the
// team, editing one by id answers the same 404 as a missing bill, and linking a
// bill to an invoice on a project you cannot see is refused like a bad id.
// Through the real routes, against a real database.
//
// The bills surface shipped without any of this while its two siblings had it —
// see team-scope-feedback-expenses.db.test.ts, which this mirrors.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({
  getAuthContext: async () => h.ctx,
  getCurrentUser: async () => null,
}));

import { GET as listBillsRoute } from "@/app/api/v1/orgs/[orgId]/bills/route";
import { PATCH as patchBill } from "@/app/api/v1/orgs/[orgId]/bills/[billId]/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "",
  restricted = "",
  open = "",
  outsider = "",
  insider = "",
  billRestricted = "",
  billOpen = "",
  billNoProject = "",
  invoiceRestricted = "";

/** A member whose roles grant every bit: only visibility can refuse them. */
const member = (userId: string): AuthContext =>
  ({ userId, orgId, orgRole: "MEMBER", abacRules: [], permissions: -1n, basePermissions: -1n }) as AuthContext;

const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    ...(body !== undefined && {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  });

async function makeBill(projectId: string | null, ref: string) {
  return (
    await prisma.bill.create({
      data: {
        orgId,
        reference: ref,
        vendorName: "Vendor",
        amount: "100.0000",
        projectId,
        createdById: insider,
      },
      select: { id: true },
    })
  ).id;
}

beforeAll(async () => {
  outsider = (
    await prisma.user.create({ data: { email: `out-${stamp}@tsb.test`, displayName: "Outsider" } })
  ).id;
  insider = (
    await prisma.user.create({ data: { email: `in-${stamp}@tsb.test`, displayName: "Insider" } })
  ).id;
  orgId = (
    await prisma.organization.create({ data: { name: `tsb ${stamp}`, slug: `tsb-${stamp}` } })
  ).id;
  await prisma.orgMember.create({
    data: { orgId, userId: outsider, role: "MEMBER", permissions: "0" },
  });
  const insiderMembership = await prisma.orgMember.create({
    data: { orgId, userId: insider, role: "MEMBER", permissions: "0" },
  });

  const key = stamp.slice(0, 3).toUpperCase();
  restricted = (
    await prisma.project.create({
      data: { orgId, name: "R", key: `BR${key}`, teamScopedAccess: true },
    })
  ).id;
  open = (await prisma.project.create({ data: { orgId, name: "O", key: `BO${key}` } })).id;
  await prisma.projectMember.create({
    data: { projectId: restricted, orgMemberId: insiderMembership.id, role: "MEMBER" },
  });

  billRestricted = await makeBill(restricted, `R-${stamp}`);
  billOpen = await makeBill(open, `O-${stamp}`);
  billNoProject = await makeBill(null, `N-${stamp}`);
  invoiceRestricted = (
    await prisma.invoice.create({
      data: {
        orgId,
        number: `INV-R-${stamp}`,
        billToName: "Client",
        projectId: restricted,
        createdById: insider,
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user
    .deleteMany({ where: { id: { in: [outsider, insider] } } })
    .catch(() => undefined);
});

async function listFor(userId: string): Promise<string[]> {
  h.ctx = member(userId);
  const res = await listBillsRoute(req("GET"), { params: Promise.resolve({ orgId }) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((b) => b.id);
}

describe("bills under a team-scoped project are that team's", () => {
  it("the list leaves out a restricted project's bill for an outsider", async () => {
    const ids = await listFor(outsider);
    expect(ids).not.toContain(billRestricted);
    // The positive controls: an open project's bill and an org-level one both
    // stay, so this is visibility and not an empty list.
    expect(ids).toContain(billOpen);
    expect(ids).toContain(billNoProject);
  });

  it("the team's own member still sees it", async () => {
    const ids = await listFor(insider);
    expect(ids).toContain(billRestricted);
    expect(ids).toContain(billOpen);
    expect(ids).toContain(billNoProject);
  });

  it("editing a restricted bill by id answers 404, the same as a missing one", async () => {
    h.ctx = member(outsider);
    const res = await patchBill(req("PATCH", { notes: "nope" }), {
      params: Promise.resolve({ orgId, billId: billRestricted }),
    });
    expect(res.status).toBe(404);
    const after = await prisma.bill.findUniqueOrThrow({ where: { id: billRestricted } });
    expect(after.notes).toBeNull();
  });

  it("the team's own member can edit it", async () => {
    h.ctx = member(insider);
    const res = await patchBill(req("PATCH", { notes: "mine" }), {
      params: Promise.resolve({ orgId, billId: billRestricted }),
    });
    expect(res.status).toBe(200);
    const after = await prisma.bill.findUniqueOrThrow({ where: { id: billRestricted } });
    expect(after.notes).toBe("mine");
  });

  it("an outsider cannot edit an org-level bill onto a project they can't see", async () => {
    h.ctx = member(outsider);
    const res = await patchBill(req("PATCH", { projectId: restricted }), {
      params: Promise.resolve({ orgId, billId: billNoProject }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = await prisma.bill.findUniqueOrThrow({ where: { id: billNoProject } });
    expect(after.projectId).toBeNull();
  });

  it("linking a bill to an invoice on a project they can't see is refused", async () => {
    h.ctx = member(outsider);
    const res = await patchBill(req("PATCH", { invoiceId: invoiceRestricted }), {
      params: Promise.resolve({ orgId, billId: billNoProject }),
    });
    expect(res.status).toBe(400);
    const after = await prisma.bill.findUniqueOrThrow({ where: { id: billNoProject } });
    expect(after.invoiceId).toBeNull();
  });

  it("the team's own member can make that same link", async () => {
    h.ctx = member(insider);
    const res = await patchBill(req("PATCH", { invoiceId: invoiceRestricted }), {
      params: Promise.resolve({ orgId, billId: billNoProject }),
    });
    expect(res.status).toBe(200);
    const after = await prisma.bill.findUniqueOrThrow({ where: { id: billNoProject } });
    expect(after.invoiceId).toBe(invoiceRestricted);
  });
});
