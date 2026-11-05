// @vitest-environment node
//
// Reimbursables, step one, through the real routes against a real database:
// an invoice can name its project (this org's, one the caller can see), and an
// invoice on a hidden project is hidden like that project's expenses; an
// expense can be marked reimbursable, which needs a project.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const calls = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: vi.fn(async () => calls.ctx) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ledger/auto-post", () => ({ safeAutoPost: vi.fn(async () => undefined) }));

import { GET as listInvoices, POST as createInvoice } from "@/app/api/v1/orgs/[orgId]/invoices/route";
import { GET as getInvoice, PUT as putInvoice } from "@/app/api/v1/orgs/[orgId]/invoices/[invoiceId]/route";
import { POST as sendInvoice } from "@/app/api/v1/orgs/[orgId]/invoices/[invoiceId]/send/route";
import { GET as listExpenses, POST as createExpense } from "@/app/api/v1/orgs/[orgId]/finance/expenses/route";
import { PUT as putExpense } from "@/app/api/v1/orgs/[orgId]/finance/expenses/[expenseId]/route";

let orgId = "";
let otherOrgId = "";
let aliceId = "";
const ALL = Object.values(Permission).reduce((acc, bit) => acc | bit, 0n);
const as = (role: OrgRole): AuthContext => ({ userId: aliceId, orgId, orgRole: role, permissions: ALL, basePermissions: ALL, abacRules: [] });

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  aliceId = (await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `rb ${stamp}`, slug: `rb-${stamp}` } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `rb2 ${stamp}`, slug: `rb2-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: aliceId, role: "MEMBER" } });
});
afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } }).catch(() => undefined);
});
beforeEach(() => {
  calls.ctx = as(OrgRole.MEMBER);
});

const req = (method: string, body?: unknown, qs = "") =>
  new NextRequest(`http://localhost/x${qs}`, { method, ...(body !== undefined && { body: JSON.stringify(body) }) });
const p = { params: Promise.resolve({ orgId: "" }) };
const orgP = () => ({ params: Promise.resolve({ orgId }) });
const invP = (invoiceId: string) => ({ params: Promise.resolve({ orgId, invoiceId }) });
const expP = (expenseId: string) => ({ params: Promise.resolve({ orgId, expenseId }) });
void p;

let n = 0;
const project = async (data: Record<string, unknown> = {}, inOrg = orgId) => {
  const s = `${++n}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
  return (await prisma.project.create({ data: { orgId: inOrg, name: `P ${s}`, key: `P${s}`, ...data } })).id;
};
const invoiceBody = (extra: Record<string, unknown> = {}) => ({
  billToName: "A client",
  lines: [{ description: "Design services", quantity: 1, unitPrice: 100 }],
  ...extra,
});
async function newInvoice(extra: Record<string, unknown> = {}) {
  const res = await createInvoice(req("POST", invoiceBody(extra)), orgP());
  return { status: res.status, body: await res.json() };
}

describe("Invoice.projectId", () => {
  it("records the project an invoice bills", async () => {
    const pid = await project();
    const res = await newInvoice({ projectId: pid });
    expect(res.status).toBe(200);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: res.body.id } })).projectId).toBe(pid);
  });

  it("refuses another org's project, and creates nothing", async () => {
    const foreign = await project({}, otherOrgId);
    const before = await prisma.invoice.count({ where: { orgId } });
    // The route's project gate refuses it, as it does an expense filed to one (403).
    expect((await newInvoice({ projectId: foreign })).status).toBe(403);
    expect(await prisma.invoice.count({ where: { orgId } })).toBe(before);
  });

  it("an edit that leaves projectId out keeps it; null detaches it", async () => {
    const pid = await project();
    const { body } = await newInvoice({ projectId: pid });
    expect((await putInvoice(req("PUT", invoiceBody()), invP(body.id))).status).toBe(200);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: body.id } })).projectId).toBe(pid);
    expect((await putInvoice(req("PUT", invoiceBody({ projectId: null })), invP(body.id))).status).toBe(200);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: body.id } })).projectId).toBeNull();
  });

  it("lists by project", async () => {
    const pid = await project();
    const { body } = await newInvoice({ projectId: pid });
    await newInvoice();
    const res = await listInvoices(req("GET", undefined, `?projectId=${pid}`), orgP());
    const list = (await res.json()).data as { id: string }[];
    expect(list.map((i) => i.id)).toEqual([body.id]);
  });

  it("an invoice on a project hidden from the caller is hidden like the project: not listed, 404 to read, edit or send", async () => {
    const hidden = await project({ teamScopedAccess: true });
    // Created by an admin, who sees every project.
    calls.ctx = as(OrgRole.ADMIN);
    const { body } = await newInvoice({ projectId: hidden });
    const open = await newInvoice();

    calls.ctx = as(OrgRole.MEMBER);
    const listed = ((await (await listInvoices(req("GET"), orgP())).json()).data as { id: string }[]).map((i) => i.id);
    expect(listed).toContain(open.body.id);
    expect(listed).not.toContain(body.id);
    expect((await getInvoice(req("GET"), invP(body.id))).status).toBe(404);
    expect((await putInvoice(req("PUT", invoiceBody()), invP(body.id))).status).toBe(404);
    expect((await sendInvoice(req("POST", {}), invP(body.id))).status).toBe(404);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: body.id } })).status).toBe("DRAFT");
  });

  it("a member can't bill a project hidden from them", async () => {
    const hidden = await project({ teamScopedAccess: true });
    expect((await newInvoice({ projectId: hidden })).status).toBe(403);
  });
});

describe("Expense.reimbursable", () => {
  const base = { amount: 250, date: "2026-11-01", category: "Printing" };

  it("defaults to the firm's cost", async () => {
    const res = await createExpense(req("POST", base), orgP());
    expect((await res.json()).reimbursable).toBe(false);
  });

  it("a reimbursable expense needs a project", async () => {
    expect((await createExpense(req("POST", { ...base, reimbursable: true }), orgP())).status).toBe(400);
    const pid = await project();
    const ok = await createExpense(req("POST", { ...base, reimbursable: true, projectId: pid }), orgP());
    expect(ok.status).toBe(201);
    expect((await ok.json()).reimbursable).toBe(true);
  });

  it("an edit saves the project it's moved to (the form always sent it; it was dropped)", async () => {
    const pid = await project();
    const e = await (await createExpense(req("POST", base), orgP())).json();
    expect((await putExpense(req("PUT", { projectId: pid }), expP(e.id))).status).toBe(200);
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: e.id } })).projectId).toBe(pid);
  });

  it("an edit can't leave a reimbursable expense without a project, either way round", async () => {
    const e = await (await createExpense(req("POST", base), orgP())).json();
    expect((await putExpense(req("PUT", { reimbursable: true }), expP(e.id))).status).toBe(400);

    const pid = await project();
    const r = await (await createExpense(req("POST", { ...base, reimbursable: true, projectId: pid }), orgP())).json();
    expect((await putExpense(req("PUT", { projectId: null }), expP(r.id))).status).toBe(400);
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: r.id } })).projectId).toBe(pid);
  });

  it("filters by reimbursable", async () => {
    const pid = await project();
    const r = await (await createExpense(req("POST", { ...base, reimbursable: true, projectId: pid }), orgP())).json();
    await createExpense(req("POST", { ...base, projectId: pid }), orgP());
    const list = (await (await listExpenses(req("GET", undefined, `?projectId=${pid}&reimbursable=true`), orgP())).json()).data as { id: string }[];
    expect(list.map((x) => x.id)).toEqual([r.id]);
  });
});
