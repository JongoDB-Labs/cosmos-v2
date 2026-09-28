import { prisma } from "@/lib/db/client";
import type { Prisma } from "@prisma/client";
import { billTotals, type BillLike } from "./bills";

/**
 * Reading and writing what the practice owes.
 *
 * The mirror of `lib/invoicing/service`. Amounts cross the wire as numbers
 * rather than Prisma Decimals, because every consumer -- the totals, the
 * screen, the tests -- does arithmetic on them, and a Decimal that reaches a
 * React tree renders as "[object Object]".
 */

const SELECT = {
  id: true,
  reference: true,
  vendorName: true,
  partnerId: true,
  projectId: true,
  invoiceId: true,
  status: true,
  terms: true,
  issueDate: true,
  dueDate: true,
  paidDate: true,
  currency: true,
  amount: true,
  amountPaid: true,
  notes: true,
  createdAt: true,
  project: { select: { key: true, name: true } },
  partner: { select: { name: true } },
  invoice: { select: { number: true, status: true } },
} as const;

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

type Row = Prisma.BillGetPayload<{ select: typeof SELECT }>;

export type BillDto = BillLike & {
  id: string;
  reference: string;
  vendorName: string;
  partnerId: string | null;
  projectId: string | null;
  invoiceId: string | null;
  issueDate: string | null;
  paidDate: string | null;
  currency: string;
  notes: string | null;
  createdAt: string;
  project: { key: string; name: string } | null;
  partner: { name: string } | null;
  invoice: { number: string; status: string } | null;
};

function shape(r: Row): BillDto {
  return {
    id: r.id,
    reference: r.reference,
    vendorName: r.vendorName,
    partnerId: r.partnerId,
    projectId: r.projectId,
    invoiceId: r.invoiceId,
    status: r.status,
    terms: r.terms,
    issueDate: iso(r.issueDate),
    dueDate: iso(r.dueDate),
    paidDate: iso(r.paidDate),
    currency: r.currency,
    amount: Number(r.amount),
    amountPaid: Number(r.amountPaid),
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
    project: r.project,
    partner: r.partner,
    invoice: r.invoice,
  };
}

export type BillFilters = {
  status?: string;
  projectId?: string;
  partnerId?: string;
  /** "none" for bills with no client invoice behind them. */
  invoice?: string;
};

export async function listBills(orgId: string, f: BillFilters = {}) {
  const STATUSES = ["DRAFT", "OPEN", "PAID", "VOID"];
  const bills = await prisma.bill.findMany({
    where: {
      orgId,
      ...(f.status && STATUSES.includes(f.status)
        ? { status: f.status as Row["status"] }
        : {}),
      ...(f.projectId ? { projectId: f.projectId } : {}),
      ...(f.partnerId ? { partnerId: f.partnerId } : {}),
      ...(f.invoice === "none" ? { invoiceId: null } : {}),
      ...(f.invoice === "linked" ? { NOT: { invoiceId: null } } : {}),
    },
    select: SELECT,
    orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
  });
  const data = bills.map(shape);
  // Computed here, not in the browser: the summary has to describe the same
  // set the table shows, and a client-side sum of a filtered page would not.
  const today = new Date().toISOString().slice(0, 10);
  return { data, totals: billTotals(data, today), today };
}

export type BillInput = {
  reference: string;
  vendorName: string;
  amount: number;
  partnerId?: string | null;
  projectId?: string | null;
  invoiceId?: string | null;
  status?: "DRAFT" | "OPEN" | "PAID" | "VOID";
  terms?: "DUE_DATE" | "PAY_WHEN_PAID";
  issueDate?: string | null;
  dueDate?: string | null;
  notes?: string | null;
};

const date = (v: string | null | undefined) =>
  v ? new Date(`${v}T00:00:00.000Z`) : null;

export async function createBill(orgId: string, userId: string, input: BillInput) {
  const payWhenPaid = input.terms === "PAY_WHEN_PAID";
  const created = await prisma.bill.create({
    data: {
      orgId,
      createdById: userId,
      reference: input.reference,
      vendorName: input.vendorName,
      amount: input.amount,
      partnerId: input.partnerId ?? null,
      projectId: input.projectId ?? null,
      invoiceId: input.invoiceId ?? null,
      status: input.status ?? "OPEN",
      terms: input.terms ?? "DUE_DATE",
      issueDate: date(input.issueDate),
      // A pay-when-paid bill has no due date by definition. Keeping one would
      // leave a date the screen must then remember to ignore.
      dueDate: payWhenPaid ? null : date(input.dueDate),
      notes: input.notes ?? null,
    },
    select: SELECT,
  });
  return shape(created);
}

export type BillPatch = {
  amountPaid?: number;
  status?: "DRAFT" | "OPEN" | "PAID" | "VOID";
  paidDate?: string | null;
  dueDate?: string | null;
  terms?: "DUE_DATE" | "PAY_WHEN_PAID";
  invoiceId?: string | null;
  projectId?: string | null;
  notes?: string | null;
};

export async function updateBill(orgId: string, billId: string, patch: BillPatch) {
  const existing = await prisma.bill.findFirst({
    where: { id: billId, orgId },
    select: { id: true, amount: true, terms: true },
  });
  if (!existing) return null;

  const terms = patch.terms ?? existing.terms;
  const payWhenPaid = terms === "PAY_WHEN_PAID";

  // Settling a bill in full marks it paid without the caller having to say so
  // twice -- and a status left OPEN on a fully-settled bill is what would put
  // it back in the past-due column tomorrow.
  const settled =
    patch.amountPaid !== undefined && patch.amountPaid >= Number(existing.amount);

  const updated = await prisma.bill.update({
    where: { id: billId },
    data: {
      ...(patch.amountPaid !== undefined ? { amountPaid: patch.amountPaid } : {}),
      ...(patch.status ? { status: patch.status } : settled ? { status: "PAID" } : {}),
      ...(patch.paidDate !== undefined
        ? { paidDate: date(patch.paidDate) }
        : settled
          ? { paidDate: new Date() }
          : {}),
      ...(patch.terms ? { terms: patch.terms } : {}),
      ...(payWhenPaid
        ? { dueDate: null }
        : patch.dueDate !== undefined
          ? { dueDate: date(patch.dueDate) }
          : {}),
      ...(patch.invoiceId !== undefined ? { invoiceId: patch.invoiceId } : {}),
      ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    },
    select: SELECT,
  });
  return shape(updated);
}
