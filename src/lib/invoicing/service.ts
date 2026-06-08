import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { ConflictError, NotFoundError } from "@/lib/rbac/check";
import { safeAutoPost } from "@/lib/ledger/auto-post";
import { invoiceTotals, lineAmount, statusFor, type InvoiceStatusValue } from "./totals";
import {
  postInvoiceToLedger,
  postPaymentToLedger,
  reverseInvoiceLedger,
} from "./posting";

const D = (v: number | string) => new Prisma.Decimal(v);

const withDetail: Prisma.InvoiceInclude = {
  lineItems: { orderBy: { sortOrder: "asc" } },
  payments: { orderBy: { receivedAt: "asc" } },
};

export type LineInput = {
  description: string;
  quantity: number | string;
  unitPrice: number | string;
  taxRate?: number | string;
  productId?: string | null;
};

export type InvoiceInput = {
  contactId?: string | null;
  contractId?: string | null;
  billToName: string;
  billToEmail?: string | null;
  dueDate?: Date | null;
  terms?: string | null;
  notes?: string | null;
  lines: LineInput[];
};

function computeLines(lines: LineInput[]) {
  return lines.map((l, i) => {
    const quantity = D(l.quantity);
    const unitPrice = D(l.unitPrice);
    const taxRate = D(l.taxRate ?? 0);
    return {
      description: l.description,
      quantity,
      unitPrice,
      taxRate,
      amount: lineAmount(quantity, unitPrice),
      productId: l.productId ?? null,
      sortOrder: i,
    };
  });
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/** INV-<year>-#### — sequence = (count for the org+year) + 1, minted inside the tx. */
async function mintInvoiceNumber(
  tx: Prisma.TransactionClient,
  orgId: string,
  year: number,
): Promise<string> {
  const prefix = `INV-${year}-`;
  const count = await tx.invoice.count({
    where: { orgId, number: { startsWith: prefix } },
  });
  return `${prefix}${String(count + 1).padStart(4, "0")}`;
}

async function assertContactInOrg(orgId: string, contactId: string) {
  const c = await prisma.crmContact.findFirst({
    where: { id: contactId, orgId },
    select: { id: true },
  });
  if (!c) throw new NotFoundError("Contact not found");
}

export async function createInvoice(
  orgId: string,
  createdById: string,
  input: InvoiceInput,
) {
  if (input.contactId) await assertContactInOrg(orgId, input.contactId);
  const computed = computeLines(input.lines);
  const totals = invoiceTotals(computed);
  const year = new Date().getFullYear();

  // Retry absorbs the rare number race — the unique [orgId, number] constraint is
  // the source of truth; a collision just re-mints with the next sequence.
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const number = await mintInvoiceNumber(tx, orgId, year);
        return tx.invoice.create({
          data: {
            orgId,
            number,
            createdById,
            contactId: input.contactId ?? null,
            contractId: input.contractId ?? null,
            billToName: input.billToName,
            billToEmail: input.billToEmail ?? null,
            dueDate: input.dueDate ?? null,
            terms: input.terms ?? null,
            notes: input.notes ?? null,
            subtotal: totals.subtotal,
            taxTotal: totals.taxTotal,
            total: totals.total,
            status: "DRAFT",
            lineItems: { create: computed },
          },
          include: withDetail,
        });
      });
    } catch (e) {
      if (isUniqueViolation(e) && attempt < 4) continue;
      throw e;
    }
  }
}

export async function updateInvoice(
  orgId: string,
  invoiceId: string,
  input: InvoiceInput,
) {
  const existing = await prisma.invoice.findFirst({
    where: { id: invoiceId, orgId },
    select: { status: true },
  });
  if (!existing) throw new NotFoundError("Invoice not found");
  if (existing.status !== "DRAFT") {
    throw new ConflictError("Only a draft invoice can be edited");
  }
  if (input.contactId) await assertContactInOrg(orgId, input.contactId);
  const computed = computeLines(input.lines);
  const totals = invoiceTotals(computed);

  return prisma.$transaction(async (tx) => {
    await tx.invoiceLineItem.deleteMany({ where: { invoiceId } });
    return tx.invoice.update({
      where: { id: invoiceId },
      data: {
        contactId: input.contactId ?? null,
        contractId: input.contractId ?? null,
        billToName: input.billToName,
        billToEmail: input.billToEmail ?? null,
        dueDate: input.dueDate ?? null,
        terms: input.terms ?? null,
        notes: input.notes ?? null,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        lineItems: { create: computed },
      },
      include: withDetail,
    });
  });
}

export async function sendInvoice(
  orgId: string,
  invoiceId: string,
  createdById: string,
  issueDate?: Date,
) {
  const inv = await prisma.invoice.findFirst({ where: { id: invoiceId, orgId } });
  if (!inv) throw new NotFoundError("Invoice not found");
  if (inv.status !== "DRAFT") {
    throw new ConflictError("Only a draft invoice can be sent");
  }
  // A non-positive total can't post (postEntry rejects a zero/negative line, and
  // safeAutoPost would swallow it) — block here so revenue/AR can't silently
  // diverge from the invoice register.
  if (!inv.total.greaterThan(0)) {
    throw new ConflictError("Cannot send an invoice with a zero or negative total");
  }
  const issued = await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: "SENT", issueDate: issueDate ?? new Date() },
    include: withDetail,
  });
  await safeAutoPost(() => postInvoiceToLedger(issued), `invoice ${issued.id}`);
  return issued;
}

export async function recordPayment(
  orgId: string,
  invoiceId: string,
  createdById: string,
  input: {
    amount: number | string;
    method?: string;
    reference?: string | null;
    receivedAt?: Date;
  },
) {
  const amount = D(input.amount);
  if (!amount.greaterThan(0)) {
    throw new ConflictError("Payment amount must be positive");
  }

  // Everything that decides the new balance happens INSIDE the tx, and the invoice
  // write is guarded on the (amountPaid, status) we read — so two concurrent
  // payments can't both apply against a stale balance (the loser's updateMany
  // matches 0 rows and the whole tx, including its Payment row, rolls back).
  const { payment, updated } = await prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findFirst({ where: { id: invoiceId, orgId } });
    if (!inv) throw new NotFoundError("Invoice not found");
    if (inv.status === "DRAFT") {
      throw new ConflictError("Send the invoice before recording a payment");
    }
    if (inv.status === "VOID") throw new ConflictError("Cannot pay a voided invoice");
    const balance = inv.total.minus(inv.amountPaid);
    if (amount.greaterThan(balance)) {
      throw new ConflictError("Payment exceeds the remaining balance");
    }

    const payment = await tx.payment.create({
      data: {
        orgId,
        invoiceId,
        amount,
        method: input.method ?? "other",
        reference: input.reference ?? null,
        receivedAt: input.receivedAt ?? new Date(),
        createdById,
      },
    });
    const newPaid = inv.amountPaid.plus(amount);
    const claim = await tx.invoice.updateMany({
      where: { id: invoiceId, orgId, amountPaid: inv.amountPaid, status: inv.status },
      data: {
        amountPaid: newPaid,
        status: statusFor(inv.total, newPaid, inv.status as InvoiceStatusValue),
      },
    });
    if (claim.count === 0) {
      throw new ConflictError("Invoice changed concurrently — please retry");
    }
    const updated = await tx.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: withDetail,
    });
    return { payment, updated };
  });
  await safeAutoPost(() => postPaymentToLedger(payment), `payment ${payment.id}`);
  return updated;
}

export async function voidInvoice(
  orgId: string,
  invoiceId: string,
  createdById: string,
) {
  const voided = await prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findFirst({
      where: { id: invoiceId, orgId },
      include: { payments: { select: { id: true } } },
    });
    if (!inv) throw new NotFoundError("Invoice not found");
    if (inv.status === "VOID") throw new ConflictError("Invoice already voided");
    if (inv.payments.length > 0 || !inv.amountPaid.isZero()) {
      throw new ConflictError("Cannot void an invoice with payments — remove them first");
    }
    // Guard on amountPaid = 0: a payment committing concurrently bumps amountPaid,
    // so this claim then matches 0 rows and the void aborts — no dangling AR credit.
    const claim = await tx.invoice.updateMany({
      where: { id: invoiceId, orgId, status: { not: "VOID" }, amountPaid: 0 },
      data: { status: "VOID" },
    });
    if (claim.count === 0) {
      throw new ConflictError("Invoice changed concurrently — please retry");
    }
    return tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: withDetail });
  });
  await safeAutoPost(
    () => reverseInvoiceLedger(orgId, invoiceId, createdById),
    `void invoice ${invoiceId}`,
  );
  return voided;
}

export async function getInvoice(orgId: string, invoiceId: string) {
  return prisma.invoice.findFirst({
    where: { id: invoiceId, orgId },
    include: withDetail,
  });
}

export async function listInvoices(orgId: string, opts?: { status?: string }) {
  return prisma.invoice.findMany({
    where: {
      orgId,
      ...(opts?.status ? { status: opts.status as InvoiceStatusValue } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
}
