// @vitest-environment node
//
// The "unbilled reimbursables" read, through the real routes against a real
// database: what counts as unbilled, how it groups and totals by project, and
// who may see which project's costs.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const calls = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: vi.fn(async () => calls.ctx) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async () => undefined) }));

import { GET as orgWide } from "@/app/api/v1/orgs/[orgId]/unbilled-reimbursables/route";
import { GET as perProject } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/unbilled-reimbursables/route";
import { POST as createInvoice } from "@/app/api/v1/orgs/[orgId]/invoices/route";
import { POST as addRb } from "@/app/api/v1/orgs/[orgId]/invoices/[invoiceId]/reimbursables/route";
import { POST as voidInvoice } from "@/app/api/v1/orgs/[orgId]/invoices/[invoiceId]/void/route";

let orgId = "";
let otherOrgId = "";
let aliceId = "";
const ALL = Object.values(Permission).reduce((acc, bit) => acc | bit, 0n);
const ctxWith = (permissions: bigint): AuthContext => ({
  userId: aliceId, orgId, orgRole: OrgRole.MEMBER, permissions, basePermissions: permissions, abacRules: [],
});

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  aliceId = (await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `ub ${stamp}`, slug: `ub-${stamp}`, settings: { finance: { reimbursableMarkupPct: 15, reimbursableLines: "two" } } } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `ub2 ${stamp}`, slug: `ub2-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: aliceId, role: "MEMBER" } });
});
afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } }).catch(() => undefined);
});
beforeEach(async () => {
  calls.ctx = ctxWith(ALL);
  // Each test starts from an org with nothing unbilled.
  await prisma.invoice.deleteMany({ where: { orgId } });
  await prisma.bill.deleteMany({ where: { orgId } });
  await prisma.expense.deleteMany({ where: { orgId } });
  await prisma.project.deleteMany({ where: { orgId } });
});

const get = async (qs = "") => {
  const res = await orgWide(new NextRequest(`http://localhost/x${qs}`), { params: Promise.resolve({ orgId }) });
  return { status: res.status, body: await res.json() };
};
const getProject = async (projectId: string) => {
  const res = await perProject(new NextRequest("http://localhost/x"), { params: Promise.resolve({ orgId, projectId }) });
  return { status: res.status, body: await res.json() };
};
const post = (body: unknown) => new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify(body) });

let n = 0;
const project = async (key: string, data: Record<string, unknown> = {}, inOrg = orgId) =>
  (await prisma.project.create({ data: { orgId: inOrg, name: `Project ${key}`, key: `${key}${++n}`, ...data } })).id;
const bill = (projectId: string, over: Record<string, unknown> = {}) =>
  prisma.bill.create({ data: { orgId, createdById: aliceId, reference: `R-${++n}`, vendorName: "A consultant", amount: 1000, status: "OPEN", projectId, ...over } });
const expense = (projectId: string, over: Record<string, unknown> = {}) =>
  prisma.expense.create({ data: { orgId, createdById: aliceId, amount: 200, date: new Date("2026-10-15"), category: "Printing", vendor: "A print shop", description: "Drawings", status: "APPROVED", reimbursable: true, projectId, ...over } });

describe("GET /orgs/{orgId}/unbilled-reimbursables", () => {
  it("groups unbilled costs by project, by key, each priced, with project and overall totals to the cent", async () => {
    // Created out of key order: the answer is ordered by key, not by insertion.
    const b = await project("BBB");
    const a = await project("AAA");
    await project("CCC"); // nothing unbilled: left out
    const b1 = await bill(a, { amount: 10.05 });
    const e1 = await expense(a, { amount: 0.3 });
    await prisma.projectFeeTerms.create({ data: { projectId: b, markupPct: 12.5 } });
    const b2 = await bill(b, { amount: 333.33, markupPct: 7.25 });
    const e2 = await expense(b, { amount: 100 });

    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.lines).toBe("two");
    expect(r.body.projects.map((p: { projectId: string }) => p.projectId)).toEqual([a, b]);
    const [pa, pb] = r.body.projects;
    expect(pa).toMatchObject({ projectName: "Project AAA" });
    expect(pa.projectKey.startsWith("AAA")).toBe(true);
    expect(pa.items).toEqual([
      { source: "bill", id: b1.id, label: `A consultant — ${b1.reference}`, date: null, cost: 10.05, markup: { pct: 15, source: "org" }, markupAmount: 1.51, total: 11.56 },
      { source: "expense", id: e1.id, label: "A print shop — Drawings", date: "2026-10-15", cost: 0.3, markup: { pct: 15, source: "org" }, markupAmount: 0.05, total: 0.35 },
    ]);
    expect(pa.totals).toEqual({ count: 2, cost: 10.35, markup: 1.56, total: 11.91 });
    expect(pb.items.map((i: { id: string; markup: unknown }) => [i.id, i.markup])).toEqual([
      [b2.id, { pct: 7.25, source: "bill" }],
      [e2.id, { pct: 12.5, source: "project" }],
    ]);
    // 333.33 × 7.25% = 24.166 → 24.17; 100 × 12.5% = 12.5.
    expect(pb.totals).toEqual({ count: 2, cost: 433.33, markup: 36.67, total: 470 });
    expect(r.body.totals).toEqual({ count: 4, cost: 443.68, markup: 38.23, total: 481.91 });
  });

  it("sums in cents, so 0.57 + 0.29 totals 0.86 exactly (floats give 0.8599999999999999)", async () => {
    const p = await project("P");
    await prisma.projectFeeTerms.create({ data: { projectId: p, markupPct: 0 } });
    await expense(p, { amount: 0.57 });
    await expense(p, { amount: 0.29 });
    const r = await get();
    expect(r.body.projects[0].totals).toEqual({ count: 2, cost: 0.86, markup: 0, total: 0.86 });
    expect(r.body.totals.total).toBe(0.86);
  });

  it("leaves out what isn't unbilled: drafts, voids, the firm's own costs, unapproved expenses, and costs an invoice has recovered", async () => {
    const p = await project("P");
    await bill(p, { status: "DRAFT" });
    await bill(p, { status: "VOID" });
    await bill(p, { projectId: null });
    await expense(p, { reimbursable: false });
    await expense(p, { status: "SUBMITTED" });
    const recovered = await bill(p);
    const inv = await prisma.invoice.create({ data: { orgId, number: `I-${++n}`, billToName: "A client", createdById: aliceId, projectId: p } });
    await prisma.bill.update({ where: { id: recovered.id }, data: { invoiceId: inv.id } });
    expect((await get()).body).toEqual({ projects: [], totals: { count: 0, cost: 0, markup: 0, total: 0 }, lines: "two" });
  });

  it("drops a cost once it is added to an invoice, and brings it back when that invoice is voided", async () => {
    const p = await project("P");
    const b1 = await bill(p);
    const created = await createInvoice(post({ billToName: "A client", projectId: p, lines: [{ description: "Fee", quantity: 1, unitPrice: 1 }] }), { params: Promise.resolve({ orgId }) });
    const j = await created.json();
    const invoiceId = (j.data?.id ?? j.id) as string;
    await addRb(post({}), { params: Promise.resolve({ orgId, invoiceId }) });
    expect((await get()).body.projects).toEqual([]);
    await voidInvoice(new NextRequest("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ orgId, invoiceId }) });
    expect((await get()).body.projects[0].items.map((i: { id: string }) => i.id)).toEqual([b1.id]);
  });

  it("never shows a project hidden from the caller, and refuses naming one", async () => {
    const open = await project("OPN");
    const hidden = await project("HID", { teamScopedAccess: true });
    await bill(open);
    await bill(hidden);
    const r = await get();
    expect(r.body.projects.map((x: { projectId: string }) => x.projectId)).toEqual([open]);
    expect(r.body.totals.count).toBe(1);
    expect((await get(`?projectId=${hidden}`)).status).toBe(403);
  });

  it("narrows to one project, and refuses another org's", async () => {
    const a = await project("AAA");
    const b = await project("BBB");
    await bill(a);
    const only = await bill(b);
    const r = await get(`?projectId=${b}`);
    expect(r.body.projects.map((x: { projectId: string }) => x.projectId)).toEqual([b]);
    expect(r.body.projects[0].items.map((i: { id: string }) => i.id)).toEqual([only.id]);
    expect(r.body.totals.count).toBe(1);
    const foreign = await project("FOR", {}, otherOrgId);
    expect((await get(`?projectId=${foreign}`)).status).toBe(403);
    expect((await get("?projectId=not-a-uuid")).status).toBe(400);
  });

  it("needs finance-read", async () => {
    await bill(await project("P"));
    calls.ctx = ctxWith(ALL & ~Permission.FINANCE_READ & ~Permission.FINANCE_MANAGE);
    expect((await get()).status).toBe(403);
    calls.ctx = ctxWith(ALL & ~Permission.FINANCE_MANAGE);
    expect((await get()).status).toBe(200);
  });
});

describe("GET /orgs/{orgId}/projects/{projectId}/unbilled-reimbursables", () => {
  it("is one project's entry, with the line preference", async () => {
    const p = await project("P");
    const b1 = await bill(p);
    const r = await getProject(p);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ projectId: p, projectName: "Project P", lines: "two", totals: { count: 1, cost: 1000, markup: 150, total: 1150 } });
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([b1.id]);
  });

  it("answers a project with nothing unbilled in the same shape, empty", async () => {
    const p = await project("P");
    expect((await getProject(p)).body).toMatchObject({ projectId: p, items: [], totals: { count: 0, cost: 0, markup: 0, total: 0 }, lines: "two" });
  });

  it("refuses a hidden project, another org's, and a caller without finance-read", async () => {
    const hidden = await project("HID", { teamScopedAccess: true });
    await bill(hidden);
    expect((await getProject(hidden)).status).toBe(403);
    expect((await getProject(await project("FOR", {}, otherOrgId))).status).toBe(403);
    const p = await project("P");
    calls.ctx = ctxWith(ALL & ~Permission.FINANCE_READ & ~Permission.FINANCE_MANAGE);
    expect((await getProject(p)).status).toBe(403);
  });
});
