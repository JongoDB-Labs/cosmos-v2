// @vitest-environment node
//
// Markup on reimbursable costs, through the real routes against a real
// database: the org's default (finance settings), a project's override (its
// fee terms), a bill's own, and which one a bill resolves to. Plus the links
// a bill names, which must be this org's.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const calls = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: vi.fn(async () => calls.ctx) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async () => undefined) }));

import { GET as getSettings, PUT as putSettings } from "@/app/api/v1/orgs/[orgId]/finance/settings/route";
import { GET as getTerms, PUT as putTerms } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/fee-terms/route";
import { GET as listBills, POST as createBill } from "@/app/api/v1/orgs/[orgId]/bills/route";
import { PATCH as patchBill } from "@/app/api/v1/orgs/[orgId]/bills/[billId]/route";

let orgId = "";
let otherOrgId = "";
let aliceId = "";
const ALL = Object.values(Permission).reduce((acc, bit) => acc | bit, 0n);
const ctxWith = (permissions: bigint, role: OrgRole = OrgRole.MEMBER): AuthContext => ({
  userId: aliceId, orgId, orgRole: role, permissions, basePermissions: permissions, abacRules: [],
});
const READ_ONLY = ALL & ~Permission.FINANCE_MANAGE;
const NO_FINANCE = ALL & ~Permission.FINANCE_MANAGE & ~Permission.FINANCE_READ;

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  aliceId = (await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `mk ${stamp}`, slug: `mk-${stamp}`, settings: { time: { internalCategories: ["Overhead"] } } } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `mk2 ${stamp}`, slug: `mk2-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: aliceId, role: "MEMBER" } });
});
afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } }).catch(() => undefined);
});
beforeEach(() => {
  calls.ctx = ctxWith(ALL);
});

const req = (method: string, body?: unknown, qs = "") =>
  new NextRequest(`http://localhost/x${qs}`, { method, ...(body !== undefined && { body: JSON.stringify(body) }) });
const orgP = () => ({ params: Promise.resolve({ orgId }) });
const projP = (projectId: string) => ({ params: Promise.resolve({ orgId, projectId }) });
const billP = (billId: string) => ({ params: Promise.resolve({ orgId, billId }) });
const unwrap = async (r: Response) => {
  const j = await r.json();
  return j && typeof j === "object" && "data" in j && Object.keys(j).length === 1 ? j.data : j;
};

let n = 0;
const project = async (data: Record<string, unknown> = {}, inOrg = orgId) => {
  const s = `${++n}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
  return (await prisma.project.create({ data: { orgId: inOrg, name: `P ${s}`, key: `P${s}`, ...data } })).id;
};
const setOrgPct = (pct: number) => putSettings(req("PUT", { reimbursableMarkupPct: pct }), orgP());
async function bill(extra: Record<string, unknown> = {}) {
  const res = await createBill(req("POST", { reference: `B-${++n}`, vendorName: "A consultant", amount: 1000, ...extra }), orgP());
  return { status: res.status, body: await unwrap(res) };
}
async function listed(id: string) {
  const res = await listBills(req("GET"), orgP());
  const body = await res.json();
  return (body.data as { id: string }[]).find((b) => b.id === id) as Record<string, unknown> | undefined;
}

describe("finance settings", () => {
  it("defaults to no markup on one line", async () => {
    const res = await getSettings(req("GET"), orgP());
    expect(res.status).toBe(200);
    expect(await unwrap(res)).toEqual({ reimbursableMarkupPct: 0, reimbursableLines: "one", canManage: true });
  });

  it("saves a field and keeps the other one, and every other org setting", async () => {
    expect((await putSettings(req("PUT", { reimbursableLines: "two" }), orgP())).status).toBe(200);
    const res = await setOrgPct(15);
    expect(await unwrap(res)).toEqual({ reimbursableMarkupPct: 15, reimbursableLines: "two" });
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.settings).toMatchObject({
      time: { internalCategories: ["Overhead"] },
      finance: { reimbursableMarkupPct: 15, reimbursableLines: "two" },
    });
  });

  it("refuses an out-of-range percent, an unknown line preference and an unknown field", async () => {
    for (const body of [{ reimbursableMarkupPct: -1 }, { reimbursableMarkupPct: 1001 }, { reimbursableLines: "three" }, { other: 1 }]) {
      expect((await putSettings(req("PUT", body), orgP())).status).toBe(400);
    }
    expect((await unwrap(await getSettings(req("GET"), orgP()))).reimbursableMarkupPct).toBe(15);
  });

  it("is read with finance-read and changed only with finance-manage", async () => {
    calls.ctx = ctxWith(READ_ONLY);
    const res = await getSettings(req("GET"), orgP());
    expect(res.status).toBe(200);
    expect((await unwrap(res)).canManage).toBe(false);
    expect((await setOrgPct(50)).status).toBe(403);
    calls.ctx = ctxWith(NO_FINANCE);
    expect((await getSettings(req("GET"), orgP())).status).toBe(403);
    calls.ctx = ctxWith(ALL);
    expect((await unwrap(await getSettings(req("GET"), orgP()))).reimbursableMarkupPct).toBe(15);
  });
});

describe("project fee terms", () => {
  it("uses the org's default until the project sets its own, and null goes back to it", async () => {
    await setOrgPct(15);
    const pid = await project();
    expect(await unwrap(await getTerms(req("GET"), projP(pid)))).toEqual({
      markupPct: null, effectiveMarkup: { pct: 15, source: "org" }, canManage: true,
    });
    const put = await putTerms(req("PUT", { markupPct: 22.5 }), projP(pid));
    expect(put.status).toBe(200);
    expect(await unwrap(put)).toEqual({ markupPct: 22.5, effectiveMarkup: { pct: 22.5, source: "project" } });
    expect(Number((await prisma.projectFeeTerms.findUniqueOrThrow({ where: { projectId: pid } })).markupPct)).toBe(22.5);
    expect(await unwrap(await putTerms(req("PUT", { markupPct: null }), projP(pid)))).toEqual({
      markupPct: null, effectiveMarkup: { pct: 15, source: "org" },
    });
  });

  it("goes with the project when it is deleted", async () => {
    const pid = await project();
    await putTerms(req("PUT", { markupPct: 5 }), projP(pid));
    await prisma.project.delete({ where: { id: pid } });
    expect(await prisma.projectFeeTerms.count({ where: { projectId: pid } })).toBe(0);
  });

  it("refuses another org's project and a hidden one, and writes nothing", async () => {
    const foreign = await project({}, otherOrgId);
    expect((await putTerms(req("PUT", { markupPct: 5 }), projP(foreign))).status).toBe(403);
    expect((await getTerms(req("GET"), projP(foreign))).status).toBe(403);
    const hidden = await project({ teamScopedAccess: true });
    expect((await putTerms(req("PUT", { markupPct: 5 }), projP(hidden))).status).toBe(403);
    expect(await prisma.projectFeeTerms.count({ where: { projectId: { in: [foreign, hidden] } } })).toBe(0);
  });

  it("is read with finance-read and changed only with finance-manage", async () => {
    const pid = await project();
    calls.ctx = ctxWith(READ_ONLY);
    expect((await unwrap(await getTerms(req("GET"), projP(pid)))).canManage).toBe(false);
    expect((await putTerms(req("PUT", { markupPct: 5 }), projP(pid))).status).toBe(403);
    calls.ctx = ctxWith(NO_FINANCE);
    expect((await getTerms(req("GET"), projP(pid))).status).toBe(403);
    expect(await prisma.projectFeeTerms.count({ where: { projectId: pid } })).toBe(0);
  });

  it("refuses an out-of-range percent", async () => {
    const pid = await project();
    expect((await putTerms(req("PUT", { markupPct: -0.01 }), projP(pid))).status).toBe(400);
    expect((await putTerms(req("PUT", { markupPct: 1000.01 }), projP(pid))).status).toBe(400);
  });
});

describe("a bill's markup", () => {
  it("resolves bill, then project, then org, and 0 is a real choice", async () => {
    await setOrgPct(15);
    const plain = await project();
    const termed = await project();
    await putTerms(req("PUT", { markupPct: 10 }), projP(termed));

    const fromOrg = await bill({ projectId: plain });
    expect(fromOrg.body.markup).toEqual({ pct: 15, source: "org" });
    expect(fromOrg.body.markupPct).toBeNull();

    const fromProject = await bill({ projectId: termed });
    expect(fromProject.body.markup).toEqual({ pct: 10, source: "project" });

    const own = await bill({ projectId: termed, markupPct: 25 });
    expect(own.body.markup).toEqual({ pct: 25, source: "bill" });

    const atCost = await bill({ projectId: termed, markupPct: 0 });
    expect(atCost.body.markup).toEqual({ pct: 0, source: "bill" });

    // The list says the same as the write.
    expect((await listed(fromOrg.body.id))?.markup).toEqual({ pct: 15, source: "org" });
    expect((await listed(fromProject.body.id))?.markup).toEqual({ pct: 10, source: "project" });
    expect((await listed(own.body.id))?.markup).toEqual({ pct: 25, source: "bill" });
    // The project's fee terms don't leak into the bill's project summary.
    expect((await listed(own.body.id))?.project).toEqual({ key: expect.any(String), name: expect.any(String) });
  });

  it("keeps the vendor's exact amount whatever the markup", async () => {
    const pid = await project();
    const b = await bill({ projectId: pid, amount: 1234.56, markupPct: 15 });
    expect(b.body.amount).toBe(1234.56);
    expect(Number((await prisma.bill.findUniqueOrThrow({ where: { id: b.body.id } })).amount)).toBe(1234.56);
  });

  it("has no markup on a bill with no project: there's no client to re-bill", async () => {
    const b = await bill({ markupPct: 15 });
    expect(b.status).toBe(201);
    expect(b.body.markup).toBeNull();
  });

  it("is changed by PATCH, and null goes back to inheriting", async () => {
    await setOrgPct(15);
    const pid = await project();
    const b = await bill({ projectId: pid });
    const set = await patchBill(req("PATCH", { markupPct: 30 }), billP(b.body.id));
    expect(set.status).toBe(200);
    expect((await unwrap(set)).markup).toEqual({ pct: 30, source: "bill" });
    const cleared = await unwrap(await patchBill(req("PATCH", { markupPct: null }), billP(b.body.id)));
    expect(cleared.markupPct).toBeNull();
    expect(cleared.markup).toEqual({ pct: 15, source: "org" });
    // A PATCH that doesn't name it leaves it alone.
    await patchBill(req("PATCH", { markupPct: 30 }), billP(b.body.id));
    expect((await unwrap(await patchBill(req("PATCH", { notes: "x" }), billP(b.body.id)))).markupPct).toBe(30);
  });

  it("refuses an out-of-range percent", async () => {
    const pid = await project();
    expect((await bill({ projectId: pid, markupPct: -1 })).status).toBe(400);
    const b = await bill({ projectId: pid });
    expect((await patchBill(req("PATCH", { markupPct: 1001 }), billP(b.body.id))).status).toBe(400);
  });

  it("is set only with finance-manage", async () => {
    const pid = await project();
    const b = await bill({ projectId: pid });
    calls.ctx = ctxWith(READ_ONLY);
    expect((await patchBill(req("PATCH", { markupPct: 30 }), billP(b.body.id))).status).toBe(403);
    calls.ctx = ctxWith(ALL);
    expect((await listed(b.body.id))?.markupPct).toBeNull();
  });
});

describe("a bill's links are this org's", () => {
  it("refuses another org's project, on create and on PATCH", async () => {
    const foreign = await project({}, otherOrgId);
    const before = await prisma.bill.count({ where: { orgId } });
    expect((await bill({ projectId: foreign })).status).toBe(403);
    expect(await prisma.bill.count({ where: { orgId } })).toBe(before);
    const b = await bill();
    expect((await patchBill(req("PATCH", { projectId: foreign }), billP(b.body.id))).status).toBe(403);
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: b.body.id } })).projectId).toBeNull();
  });

  it("refuses a project the caller can't see", async () => {
    const hidden = await project({ teamScopedAccess: true });
    expect((await bill({ projectId: hidden })).status).toBe(403);
  });

  it("refuses another org's invoice, on create and on PATCH", async () => {
    const foreignInvoice = await prisma.invoice.create({
      data: { orgId: otherOrgId, number: `X-${++n}`, billToName: "Someone", createdById: aliceId },
    });
    expect((await bill({ invoiceId: foreignInvoice.id })).status).toBe(400);
    const b = await bill();
    expect((await patchBill(req("PATCH", { invoiceId: foreignInvoice.id }), billP(b.body.id))).status).toBe(400);
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: b.body.id } })).invoiceId).toBeNull();
  });

  it("accepts this org's invoice", async () => {
    const own = await prisma.invoice.create({
      data: { orgId, number: `O-${++n}`, billToName: "A client", createdById: aliceId },
    });
    const b = await bill({ invoiceId: own.id });
    expect(b.status).toBe(201);
    expect(b.body.invoiceId).toBe(own.id);
  });
});
