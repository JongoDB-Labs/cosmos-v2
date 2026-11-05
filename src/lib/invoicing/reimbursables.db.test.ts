// @vitest-environment node
//
// "Add reimbursables", through the real routes against a real database: which
// costs are unbilled, how they land on the invoice (one line or two), the stamp
// that stops a cost being billed twice, what releases it again, and the
// ledger entry the issued invoice posts (markup to revenue, cost to recovery).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { ACCOUNT_CODES } from "@/lib/ledger/chart-of-accounts";

const calls = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: vi.fn(async () => calls.ctx) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async () => undefined) }));

import { GET as listRb, POST as addRb } from "@/app/api/v1/orgs/[orgId]/invoices/[invoiceId]/reimbursables/route";
import { POST as createInvoice } from "@/app/api/v1/orgs/[orgId]/invoices/route";
import { PUT as putInvoice, DELETE as deleteInvoice } from "@/app/api/v1/orgs/[orgId]/invoices/[invoiceId]/route";
import { POST as sendInvoice } from "@/app/api/v1/orgs/[orgId]/invoices/[invoiceId]/send/route";
import { POST as voidInvoice } from "@/app/api/v1/orgs/[orgId]/invoices/[invoiceId]/void/route";
import { PUT as putSettings } from "@/app/api/v1/orgs/[orgId]/finance/settings/route";

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
  orgId = (await prisma.organization.create({ data: { name: `ar ${stamp}`, slug: `ar-${stamp}` } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `ar2 ${stamp}`, slug: `ar2-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: aliceId, role: "MEMBER" } });
});
afterAll(async () => {
  // Journal lines restrict their accounts: clear the ledger before the org cascade.
  await prisma.journalEntry.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } }).catch(() => undefined);
});
beforeEach(async () => {
  calls.ctx = ctxWith(ALL);
  await putSettings(req("PUT", { reimbursableMarkupPct: 15, reimbursableLines: "one" }), { params: Promise.resolve({ orgId }) });
});

const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", { method, ...(body !== undefined && { body: JSON.stringify(body) }) });
const invP = (invoiceId: string) => ({ params: Promise.resolve({ orgId, invoiceId }) });
const unwrap = async (r: Response) => {
  const j = await r.json();
  return j && typeof j === "object" && "data" in j && Object.keys(j).length === 1 ? j.data : j;
};

let n = 0;
const project = async (data: Record<string, unknown> = {}) => {
  const s = `${++n}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
  return (await prisma.project.create({ data: { orgId, name: `P ${s}`, key: `P${s}`, ...data } })).id;
};
const bill = (projectId: string, over: Record<string, unknown> = {}) =>
  prisma.bill.create({
    data: { orgId, createdById: aliceId, reference: `R-${++n}`, vendorName: "A consultant", amount: 1000, status: "OPEN", projectId, issueDate: new Date(`2026-10-${String(n % 28 + 1).padStart(2, "0")}`), ...over },
  });
const expense = (projectId: string, over: Record<string, unknown> = {}) =>
  prisma.expense.create({
    data: { orgId, createdById: aliceId, amount: 200, date: new Date("2026-10-15"), category: "Printing", vendor: "A print shop", description: "Drawings", status: "APPROVED", reimbursable: true, projectId, ...over },
  });
async function draft(projectId: string | null, lines = [{ description: "Design services", quantity: 1, unitPrice: 500 }]) {
  const res = await createInvoice(req("POST", { billToName: "A client", projectId, lines }), { params: Promise.resolve({ orgId }) });
  expect(res.status).toBe(200);
  return (await unwrap(res)).id as string;
}
const list = async (invoiceId: string) => {
  const res = await listRb(req("GET"), invP(invoiceId));
  return { status: res.status, body: await unwrap(res) };
};
const add = async (invoiceId: string, body: unknown = {}) => {
  const res = await addRb(req("POST", body), invP(invoiceId));
  return { status: res.status, body: await unwrap(res) };
};
const lines = (invoiceId: string) =>
  prisma.invoiceLineItem.findMany({ where: { invoiceId }, orderBy: { sortOrder: "asc" } });
const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

describe("which costs are unbilled", () => {
  it("lists the project's OPEN and PAID bills and APPROVED reimbursable expenses, priced", async () => {
    const pid = await project();
    const other = await project();
    const open = await bill(pid);
    const paid = await bill(pid, { status: "PAID", markupPct: 20 });
    await bill(pid, { status: "DRAFT" });
    await bill(pid, { status: "VOID" });
    await bill(other);
    const exp = await expense(pid);
    await expense(pid, { reimbursable: false });
    await expense(pid, { status: "SUBMITTED" });
    await prisma.projectFeeTerms.create({ data: { projectId: pid, markupPct: 10 } });

    const r = await list(await draft(pid));
    expect(r.status).toBe(200);
    expect(r.body.lines).toBe("one");
    const byId = Object.fromEntries((r.body.items as { id: string }[]).map((i) => [i.id, i]));
    expect(Object.keys(byId).sort()).toEqual([open.id, paid.id, exp.id].sort());
    expect(byId[open.id]).toMatchObject({ source: "bill", label: `A consultant — ${open.reference}`, cost: 1000, markup: { pct: 10, source: "project" }, markupAmount: 100, total: 1100 });
    expect(byId[paid.id]).toMatchObject({ markup: { pct: 20, source: "bill" }, total: 1200 });
    expect(byId[exp.id]).toMatchObject({ source: "expense", label: "A print shop — Drawings", cost: 200, markup: { pct: 10, source: "project" }, total: 220 });
  });

  it("refuses an invoice that isn't a draft, or has no project", async () => {
    expect((await list(await draft(null))).status).toBe(409);
    const pid = await project();
    await bill(pid);
    const id = await draft(pid);
    await sendInvoice(req("POST", {}), invP(id));
    expect((await list(id)).status).toBe(409);
    expect((await add(id)).status).toBe(409);
  });
});

describe("adding them", () => {
  it("one line each at cost plus markup, stamps each cost, and keeps its amount", async () => {
    const pid = await project();
    const b = await bill(pid, { amount: 1234.56 });
    const e = await expense(pid, { amount: 10.05 });
    const id = await draft(pid);

    const r = await add(id);
    expect(r.status).toBe(200);
    expect(r.body.added).toBe(2);

    const ls = await lines(id);
    expect(ls.map((l) => [l.description, num(l.amount), l.reimbursableKind, num(l.passThroughAmount), l.billId, l.expenseId])).toEqual([
      ["Design services", 500, null, null, null, null],
      [`A consultant — ${b.reference} (cost plus 15%)`, 1419.74, "COMBINED", 1234.56, b.id, null],
      ["A print shop — Drawings (cost plus 15%)", 11.56, "COMBINED", 10.05, null, e.id],
    ]);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(num(inv.subtotal)).toBe(1931.3);
    expect(num(inv.total)).toBe(1931.3);
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: b.id } })).invoiceId).toBe(id);
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: e.id } })).invoiceId).toBe(id);
    // The cost keeps the vendor's exact amount.
    expect(num((await prisma.bill.findUniqueOrThrow({ where: { id: b.id } })).amount)).toBe(1234.56);
    expect(num((await prisma.expense.findUniqueOrThrow({ where: { id: e.id } })).amount)).toBe(10.05);
  });

  it("two lines each when the org prefers it, with no markup line at 0%", async () => {
    await putSettings(req("PUT", { reimbursableLines: "two" }), { params: Promise.resolve({ orgId }) });
    const pid = await project();
    const b = await bill(pid);
    const atCost = await bill(pid, { markupPct: 0 });
    const id = await draft(pid, [{ description: "Fee", quantity: 1, unitPrice: 1 }]);
    await add(id);
    const ls = (await lines(id)).slice(1);
    expect(ls.map((l) => [l.reimbursableKind, num(l.amount), num(l.passThroughAmount), l.billId])).toEqual([
      ["COST", 1000, 1000, b.id],
      ["MARKUP", 150, 0, b.id],
      ["COST", 1000, 1000, atCost.id],
    ]);
    expect(ls[1].description).toBe(`Markup 15% on A consultant — ${b.reference}`);
  });

  it("never bills a cost twice: a second add finds nothing, another invoice can't pick it", async () => {
    const pid = await project();
    const b = await bill(pid);
    const first = await draft(pid);
    await add(first);
    expect((await add(first)).body.added).toBe(0);
    const second = await draft(pid);
    expect((await list(second)).body.items).toEqual([]);
    expect((await add(second, { billIds: [b.id] })).status).toBe(409);
    expect(await prisma.invoiceLineItem.count({ where: { invoiceId: second, billId: b.id } })).toBe(0);
  });

  it("adds only the costs picked, and refuses one that isn't this project's, adding nothing", async () => {
    const pid = await project();
    const other = await project();
    const a = await bill(pid);
    const b = await bill(pid);
    const foreign = await bill(other);
    const id = await draft(pid);
    expect((await add(id, { billIds: [a.id, foreign.id] })).status).toBe(409);
    expect(await prisma.bill.count({ where: { id: { in: [a.id, foreign.id] }, invoiceId: { not: null } } })).toBe(0);
    expect(await lines(id)).toHaveLength(1);
    expect((await add(id, { billIds: [a.id] })).body.added).toBe(1);
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: b.id } })).invoiceId).toBeNull();
  });

  it("lets two invoices race for the same cost and bills it once", async () => {
    const pid = await project();
    const b = await bill(pid);
    const [x, y] = [await draft(pid), await draft(pid)];
    const results = await Promise.all([add(x, { billIds: [b.id] }), add(y, { billIds: [b.id] })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.invoiceLineItem.count({ where: { billId: b.id } })).toBe(1);
    const winner = results[0].status === 200 ? x : y;
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: b.id } })).invoiceId).toBe(winner);
  });
});

describe("what releases a cost", () => {
  it("a voided invoice recovered nothing: its costs can be billed again", async () => {
    const pid = await project();
    const b = await bill(pid);
    const first = await draft(pid);
    await add(first);
    expect((await voidInvoice(req("POST"), invP(first))).status).toBe(200);
    const second = await draft(pid);
    expect((await list(second)).body.items.map((i: { id: string }) => i.id)).toEqual([b.id]);
    expect((await add(second)).body.added).toBe(1);
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: b.id } })).invoiceId).toBe(second);
  });

  it("deleting the draft releases them", async () => {
    const pid = await project();
    const e = await expense(pid);
    const id = await draft(pid);
    await add(id);
    expect((await deleteInvoice(req("DELETE"), invP(id))).status).toBe(200);
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: e.id } })).invoiceId).toBeNull();
  });

  it("an edit that keeps a re-billed line keeps it billed, at its pass-through; one that drops it releases the cost", async () => {
    const pid = await project();
    const kept = await bill(pid);
    const dropped = await expense(pid);
    const id = await draft(pid);
    await add(id);
    const ls = await lines(id);
    const keptLine = ls.find((l) => l.billId === kept.id)!;
    const res = await putInvoice(
      req("PUT", {
        billToName: "A client",
        lines: [
          { description: "Design services", quantity: 1, unitPrice: 600 },
          { description: keptLine.description, quantity: 1, unitPrice: Number(keptLine.unitPrice), billId: kept.id, reimbursableKind: "COMBINED" },
        ],
      }),
      invP(id),
    );
    expect(res.status).toBe(200);
    const after = await lines(id);
    expect(after.map((l) => [l.billId, l.reimbursableKind, num(l.passThroughAmount)])).toEqual([[null, null, null], [kept.id, "COMBINED", 1000]]);
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: kept.id } })).invoiceId).toBe(id);
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: dropped.id } })).invoiceId).toBeNull();
  });

  it("caps a kept line's pass-through at its new amount", async () => {
    const pid = await project();
    const b = await bill(pid);
    const id = await draft(pid);
    await add(id);
    await putInvoice(
      req("PUT", { billToName: "A client", lines: [{ description: "Discounted", quantity: 1, unitPrice: 900, billId: b.id, reimbursableKind: "COMBINED" }] }),
      invP(id),
    );
    expect(num((await lines(id))[0].passThroughAmount)).toBe(900);
  });

  it("refuses a re-billed line made up by hand, on create and on edit", async () => {
    const pid = await project();
    const b = await bill(pid);
    const tagged = { description: "Sneaky", quantity: 1, unitPrice: 1000, billId: b.id, reimbursableKind: "COMBINED" };
    const create = await createInvoice(req("POST", { billToName: "A client", projectId: pid, lines: [tagged] }), { params: Promise.resolve({ orgId }) });
    expect(create.status).toBe(409);
    const id = await draft(pid);
    expect((await putInvoice(req("PUT", { billToName: "A client", lines: [tagged] }), invP(id))).status).toBe(409);
    // Nor can an edit duplicate a real one to book its cost twice.
    await add(id);
    const real = (await lines(id)).find((l) => l.billId === b.id)!;
    const twice = { description: real.description, quantity: 1, unitPrice: Number(real.unitPrice), billId: b.id, reimbursableKind: "COMBINED" };
    expect((await putInvoice(req("PUT", { billToName: "A client", lines: [twice, twice] }), invP(id))).status).toBe(409);
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: b.id } })).invoiceId).toBe(id);
  });

  it("leaves a bill linked to the invoice by hand alone, even when the edit releases a re-billed one", async () => {
    const pid = await project();
    const rebilled = await bill(pid);
    const id = await draft(pid);
    await add(id);
    // Linked by hand after the add, so it has no line on the invoice.
    const manual = await bill(pid, { invoiceId: id });
    await putInvoice(req("PUT", { billToName: "A client", lines: [{ description: "Fee", quantity: 1, unitPrice: 1 }] }), invP(id));
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: rebilled.id } })).invoiceId).toBeNull();
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: manual.id } })).invoiceId).toBe(id);
  });

  it("won't move an invoice carrying re-billed lines to another project", async () => {
    const pid = await project();
    const other = await project();
    const b = await bill(pid);
    const id = await draft(pid);
    await add(id);
    const real = (await lines(id)).find((l) => l.billId === b.id)!;
    const keep = { description: real.description, quantity: 1, unitPrice: Number(real.unitPrice), billId: b.id, reimbursableKind: "COMBINED" };
    expect((await putInvoice(req("PUT", { billToName: "A client", projectId: other, lines: [keep] }), invP(id))).status).toBe(409);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).projectId).toBe(pid);
  });
});

describe("the issued invoice's ledger entry", () => {
  async function entry(invoiceId: string) {
    const e = await prisma.journalEntry.findFirstOrThrow({ where: { orgId, source: "INVOICE", sourceId: invoiceId }, include: { lines: { include: { account: true } } } });
    const by = (code: string) => e.lines.filter((l) => l.account.code === code).reduce((s, l) => s + Number(l.amount), 0);
    return { by, lines: e.lines };
  }

  for (const mode of ["one", "two"] as const) {
    it(`books the markup as revenue and the cost as recovery, AR = revenue + recovery (${mode} line)`, async () => {
      await putSettings(req("PUT", { reimbursableLines: mode }), { params: Promise.resolve({ orgId }) });
      const pid = await project();
      await bill(pid, { amount: 10.05 });
      await expense(pid, { amount: 333.33, });
      await prisma.projectFeeTerms.create({ data: { projectId: pid, markupPct: 7.25 } });
      const id = await draft(pid);
      await add(id);
      expect((await sendInvoice(req("POST", {}), invP(id))).status).toBe(200);
      const { by } = await entry(id);
      // 10.05 × 7.25% = 0.7286 → 0.73; 333.33 × 7.25% = 24.166 → 24.17.
      expect(by(ACCOUNT_CODES.REIMBURSABLE_RECOVERY)).toBeCloseTo(343.38, 10);
      expect(by(ACCOUNT_CODES.SALES_REVENUE)).toBeCloseTo(500 + 0.73 + 24.17, 10);
      expect(by(ACCOUNT_CODES.ACCOUNTS_RECEIVABLE)).toBeCloseTo(by(ACCOUNT_CODES.SALES_REVENUE) + by(ACCOUNT_CODES.REIMBURSABLE_RECOVERY), 10);
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id } });
      expect(by(ACCOUNT_CODES.ACCOUNTS_RECEIVABLE)).toBeCloseTo(Number(inv.total), 10);
    });
  }

  it("an invoice of costs at cost posts recovery only", async () => {
    await putSettings(req("PUT", { reimbursableMarkupPct: 0 }), { params: Promise.resolve({ orgId }) });
    const pid = await project();
    await bill(pid, { amount: 400 });
    const id = await createInvoice(req("POST", { billToName: "A client", projectId: pid, lines: [{ description: "Placeholder", quantity: 1, unitPrice: 0 }] }), { params: Promise.resolve({ orgId }) })
      .then(unwrap).then((b) => b.id as string);
    await add(id);
    expect((await sendInvoice(req("POST", {}), invP(id))).status).toBe(200);
    const { by } = await entry(id);
    expect(by(ACCOUNT_CODES.REIMBURSABLE_RECOVERY)).toBe(400);
    expect(by(ACCOUNT_CODES.SALES_REVENUE)).toBe(0);
    expect(by(ACCOUNT_CODES.ACCOUNTS_RECEIVABLE)).toBe(400);
  });
});

describe("who may", () => {
  it("lists with finance-read and adds only with finance-manage", async () => {
    const pid = await project();
    await bill(pid);
    const id = await draft(pid);
    calls.ctx = ctxWith(ALL & ~Permission.FINANCE_MANAGE);
    expect((await list(id)).status).toBe(200);
    expect((await add(id)).status).toBe(403);
    calls.ctx = ctxWith(ALL & ~Permission.FINANCE_MANAGE & ~Permission.FINANCE_READ);
    expect((await list(id)).status).toBe(403);
    calls.ctx = ctxWith(ALL);
    expect(await prisma.bill.count({ where: { projectId: pid, invoiceId: { not: null } } })).toBe(0);
  });

  it("answers an invoice on a hidden project, or another org's, as not found", async () => {
    const hidden = await project({ teamScopedAccess: true });
    await bill(hidden);
    const id = await draft(null);
    await prisma.invoice.update({ where: { id }, data: { projectId: hidden } });
    expect((await list(id)).status).toBe(404);
    expect((await add(id)).status).toBe(404);
    const foreign = await prisma.invoice.create({ data: { orgId: otherOrgId, number: `X-${++n}`, billToName: "Someone", createdById: aliceId } });
    expect((await list(foreign.id)).status).toBe(404);
    expect((await add(foreign.id)).status).toBe(404);
  });
});
