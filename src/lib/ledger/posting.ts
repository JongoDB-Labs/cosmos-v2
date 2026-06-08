import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { sumMoney } from "@/lib/money";

export type PostingLine = {
  accountId: string;
  direction: "DEBIT" | "CREDIT";
  amount: Prisma.Decimal;
  description?: string | null;
  projectId?: string | null;
  contractId?: string | null;
  costObjectiveId?: string | null;
  costPoolId?: string | null;
};

/** PURE. Throws unless `lines` form a balanced double-entry: >=2 lines, each side > 0, sum(debits) == sum(credits). */
export function assertBalanced(lines: PostingLine[]): void {
  if (lines.length < 2) throw new Error("A journal entry needs at least two lines");
  if (lines.some((l) => l.amount.lte(0))) throw new Error("Each line amount must be positive");
  const debits = sumMoney(lines.filter((l) => l.direction === "DEBIT").map((l) => l.amount));
  const credits = sumMoney(lines.filter((l) => l.direction === "CREDIT").map((l) => l.amount));
  if (debits.lte(0) || credits.lte(0)) throw new Error("Debits and credits must each be positive");
  if (!debits.equals(credits)) throw new Error(`Unbalanced entry: debits ${debits.toString()} != credits ${credits.toString()}`);
}

/** PURE. Returns the same lines with DEBIT<->CREDIT swapped (amounts + dimensions preserved). */
export function reversedLines(lines: PostingLine[]): PostingLine[] {
  return lines.map((l) => ({ ...l, direction: l.direction === "DEBIT" ? "CREDIT" : "DEBIT" }));
}

export type PostEntryInput = {
  orgId: string;
  createdById: string;
  date: Date;
  memo?: string;
  source?: "MANUAL" | "REVENUE" | "EXPENSE" | "INVOICE" | "PAYMENT" | "PAYROLL";
  sourceId?: string | null;
  lines: PostingLine[];
};

export class ClosedPeriodError extends Error {
  constructor(date: Date) { super(`Cannot post into a closed accounting period (${date.toISOString().slice(0, 10)})`); this.name = "ClosedPeriodError"; }
}

/**
 * Thin I/O. Validates balance + the closed-period guard, mints an org-sequential entryNumber,
 * and persists the entry + lines in one transaction. Idempotent on (orgId, source, sourceId).
 */
export async function postEntry(input: PostEntryInput, opts?: { allowClosedPeriod?: boolean }) {
  assertBalanced(input.lines);
  const source = input.source ?? "MANUAL";

  if (input.sourceId) {
    const existing = await prisma.journalEntry.findFirst({
      where: { orgId: input.orgId, source, sourceId: input.sourceId, status: "POSTED" },
      include: { lines: true },
    });
    if (existing) return existing;
  }

  if (!opts?.allowClosedPeriod) {
    const closed = await prisma.accountingPeriod.findFirst({
      where: { orgId: input.orgId, status: "CLOSED", startDate: { lte: input.date }, endDate: { gte: input.date } },
    });
    if (closed) throw new ClosedPeriodError(input.date);
  }

  return prisma.$transaction(async (tx) => {
    const max = await tx.journalEntry.aggregate({ where: { orgId: input.orgId }, _max: { entryNumber: true } });
    const entryNumber = (max._max.entryNumber ?? 0) + 1;
    return tx.journalEntry.create({
      data: {
        orgId: input.orgId, entryNumber, date: input.date, memo: input.memo ?? "",
        status: "POSTED", source, sourceId: input.sourceId ?? null, postedAt: new Date(), createdById: input.createdById,
        lines: { create: input.lines.map((l, i) => ({
          orgId: input.orgId, accountId: l.accountId, direction: l.direction, amount: l.amount,
          description: l.description ?? null, sortOrder: i, projectId: l.projectId ?? null,
          contractId: l.contractId ?? null, costObjectiveId: l.costObjectiveId ?? null, costPoolId: l.costPoolId ?? null,
        })) },
      },
      include: { lines: true },
    });
  });
}

/** PURE. A POSTED entry with no reversal can be voided. */
export function isVoidable(entry: { status: string; reversedBy: { id: string }[] }): boolean {
  return entry.status === "POSTED" && entry.reversedBy.length === 0;
}

/** Thin I/O. Marks a POSTED entry VOID (soft-delete; statements already exclude non-POSTED). */
export async function voidEntry(orgId: string, entryId: string) {
  const entry = await prisma.journalEntry.findFirst({ where: { id: entryId, orgId }, include: { reversedBy: { select: { id: true } } } });
  if (!entry) throw new Error("Journal entry not found");
  if (!isVoidable(entry)) throw new Error("Only a POSTED, non-reversed entry can be voided");
  return prisma.journalEntry.update({ where: { id: entryId }, data: { status: "VOID" } });
}

/** Thin I/O. Posts a reversing entry (swapped directions) for an existing POSTED entry.
 *  Reversals post at the current date and respect the closed-period guard (pass allowClosedPeriod to override). */
export async function reverseEntry(orgId: string, entryId: string, createdById: string, opts?: { allowClosedPeriod?: boolean }) {
  const original = await prisma.journalEntry.findFirst({ where: { id: entryId, orgId }, include: { lines: true } });
  if (!original) throw new Error("Journal entry not found");
  if (original.status !== "POSTED") throw new Error("Only POSTED entries can be reversed");
  const date = new Date();
  if (!opts?.allowClosedPeriod) {
    const closed = await prisma.accountingPeriod.findFirst({ where: { orgId, status: "CLOSED", startDate: { lte: date }, endDate: { gte: date } } });
    if (closed) throw new ClosedPeriodError(date);
  }
  const lines: PostingLine[] = original.lines.map((l) => ({
    accountId: l.accountId, direction: l.direction, amount: l.amount, description: l.description,
    projectId: l.projectId, contractId: l.contractId, costObjectiveId: l.costObjectiveId, costPoolId: l.costPoolId,
  }));
  const rev = reversedLines(lines);
  return prisma.$transaction(async (tx) => {
    const max = await tx.journalEntry.aggregate({ where: { orgId }, _max: { entryNumber: true } });
    const entryNumber = (max._max.entryNumber ?? 0) + 1;
    return tx.journalEntry.create({
      data: {
        orgId, entryNumber, date, memo: `Reversal of #${original.entryNumber}`,
        status: "POSTED", source: "MANUAL", reversesId: original.id, postedAt: new Date(), createdById,
        lines: { create: rev.map((l, i) => ({ orgId, accountId: l.accountId, direction: l.direction, amount: l.amount, description: l.description ?? null, sortOrder: i, projectId: l.projectId ?? null, contractId: l.contractId ?? null, costObjectiveId: l.costObjectiveId ?? null, costPoolId: l.costPoolId ?? null })) },
      },
      include: { lines: true },
    });
  });
}
