import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { NotFoundError, ConflictError } from "@/lib/rbac/check";
import {
  postExpenseToLedger,
  postRevenueToLedger,
  safeAutoPost,
} from "@/lib/ledger/auto-post";

/**
 * Which side of the books a (signed, customer-perspective) bank amount belongs to:
 * a negative amount is money OUT (an Expense), a non-negative amount is money IN
 * (Revenue). This is the inflow guard — it's why a +$500 deposit no longer books
 * as an expense.
 */
export function reconcileKind(amount: Prisma.Decimal): "expense" | "revenue" {
  return amount.isNegative() ? "expense" : "revenue";
}

/** Expense magnitude for a (signed) bank amount: outflows (negative) → positive expense. */
export function expenseAmountFor(amount: Prisma.Decimal): Prisma.Decimal {
  return amount.isNegative() ? amount.negated() : amount;
}

/**
 * Revenue magnitude for a (signed) bank amount: inflows are already non-negative, so
 * this is the amount itself. Kept distinct from `expenseAmountFor` for intent clarity
 * (they happen to compute the same magnitude, but mean opposite sides of the ledger).
 */
export function revenueAmountFor(amount: Prisma.Decimal): Prisma.Decimal {
  return amount.isNegative() ? amount.negated() : amount;
}

/**
 * Batch category suggestions — ONE query, matched in memory by leading token.
 * Each suggestion is the category of the most-recent Expense whose vendor or
 * description contains the txn's first word. Bounded to the 500 most-recent
 * expenses (v1 heuristic — older history isn't consulted), which keeps the
 * inbox load to a single round-trip regardless of how many rows are pending.
 */
export async function suggestCategories(
  orgId: string,
  descriptions: string[],
): Promise<(string | null)[]> {
  const priors = await prisma.expense.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { vendor: true, description: true, category: true },
  });
  return descriptions.map((desc) => {
    const token = desc.trim().split(/\s+/)[0]?.toLowerCase();
    if (!token) return null;
    const hit = priors.find(
      (p) =>
        p.vendor?.toLowerCase().includes(token) ||
        p.description?.toLowerCase().includes(token),
    );
    return hit?.category || null;
  });
}

async function loadReconcilable(orgId: string, txnId: string) {
  const txn = await prisma.bankTransaction.findFirst({
    where: { id: txnId, orgId },
  });
  if (!txn) throw new NotFoundError("Bank transaction not found");
  // Only an IMPORTED txn is reconcilable. Whitelisting the start state (rather
  // than blacklisting terminal ones) also covers CATEGORIZED and any future
  // intermediate state — no reconciled txn can be acted on twice.
  if (txn.status !== "IMPORTED") {
    throw new ConflictError("Transaction already reconciled");
  }
  return txn;
}

/**
 * Categorize → create the sign-appropriate source doc from the txn + post it to the
 * GL; mark the txn POSTED. Outflows become an APPROVED Expense, inflows a Revenue.
 * `label` is the inbox's free-text input (Expense category / Revenue client).
 */
export async function categorizeTransaction(
  orgId: string,
  txnId: string,
  label: string,
  createdById: string,
) {
  const txn = await loadReconcilable(orgId, txnId);

  // The status-scoped updateMany in each branch is the concurrency guard: of two
  // racing categorize calls only one matches `status: "IMPORTED"`, so the other
  // gets count 0 and aborts — preventing a duplicate source doc + double GL post.
  if (reconcileKind(txn.amount) === "expense") {
    const { expense, updated } = await prisma.$transaction(async (tx) => {
      const claim = await tx.bankTransaction.updateMany({
        where: { id: txn.id, orgId, status: "IMPORTED" },
        data: { status: "POSTED", category: label },
      });
      if (claim.count === 0) throw new ConflictError("Transaction already reconciled");
      const expense = await tx.expense.create({
        data: {
          orgId,
          amount: expenseAmountFor(txn.amount),
          currency: "USD",
          date: txn.postedDate,
          category: label,
          vendor: txn.description || null,
          description: txn.description,
          status: "APPROVED",
          createdById,
        },
      });
      const updated = await tx.bankTransaction.update({
        where: { id: txn.id },
        data: { matchedExpenseId: expense.id },
      });
      return { expense, updated };
    });
    await safeAutoPost(() => postExpenseToLedger(expense), `expense ${expense.id}`);
    return updated;
  }

  // inflow → Revenue
  const { revenue, updated } = await prisma.$transaction(async (tx) => {
    const claim = await tx.bankTransaction.updateMany({
      where: { id: txn.id, orgId, status: "IMPORTED" },
      data: { status: "POSTED", category: label },
    });
    if (claim.count === 0) throw new ConflictError("Transaction already reconciled");
    const revenue = await tx.revenue.create({
      data: {
        orgId,
        amount: revenueAmountFor(txn.amount),
        currency: "USD",
        date: txn.postedDate,
        client: label || null,
        description: txn.description,
        type: "ONE_TIME",
        createdById,
      },
    });
    const updated = await tx.bankTransaction.update({
      where: { id: txn.id },
      data: { matchedRevenueId: revenue.id },
    });
    return { revenue, updated };
  });
  await safeAutoPost(() => postRevenueToLedger(revenue), `revenue ${revenue.id}`);
  return updated;
}

/**
 * Match → link the txn to an EXISTING source doc (already posted on its own create);
 * mark MATCHED. `targetType` must match the txn's direction (outflow→expense,
 * inflow→revenue) so a deposit can't be linked to an expense.
 */
export async function matchTransaction(
  orgId: string,
  txnId: string,
  targetType: "expense" | "revenue",
  targetId: string,
) {
  const txn = await loadReconcilable(orgId, txnId);
  if (reconcileKind(txn.amount) !== targetType) {
    throw new ConflictError("Target type does not match the transaction direction");
  }
  if (targetType === "expense") {
    const expense = await prisma.expense.findFirst({
      where: { id: targetId, orgId },
      select: { id: true },
    });
    if (!expense) throw new NotFoundError("Expense not found");
  } else {
    const revenue = await prisma.revenue.findFirst({
      where: { id: targetId, orgId },
      select: { id: true },
    });
    if (!revenue) throw new NotFoundError("Revenue not found");
  }
  // Atomic claim: only an IMPORTED txn transitions to MATCHED.
  const claim = await prisma.bankTransaction.updateMany({
    where: { id: txn.id, orgId, status: "IMPORTED" },
    data: {
      status: "MATCHED",
      matchedExpenseId: targetType === "expense" ? targetId : null,
      matchedRevenueId: targetType === "revenue" ? targetId : null,
    },
  });
  if (claim.count === 0) throw new ConflictError("Transaction already reconciled");
  // The row certainly exists (we just claimed it) — return the non-null type so the
  // route never serializes a null 200.
  return prisma.bankTransaction.findUniqueOrThrow({ where: { id: txn.id } });
}

export type MatchCandidate = {
  id: string;
  kind: "expense" | "revenue";
  amount: string;
  date: string;
  label: string;
};

/**
 * Candidate source docs to match a txn against: the sign-appropriate kind (Expenses
 * for an outflow, Revenues for an inflow), the 100 most-recent, re-sorted so the ones
 * closest to the txn's magnitude float to the top. Capped at 25. One query.
 */
export async function listMatchCandidates(
  orgId: string,
  txn: { amount: Prisma.Decimal },
): Promise<MatchCandidate[]> {
  const target = txn.amount.abs(); // positive magnitude to compare against
  const byCloseness = (
    a: { amount: Prisma.Decimal },
    b: { amount: Prisma.Decimal },
  ) => a.amount.minus(target).abs().comparedTo(b.amount.minus(target).abs());

  if (reconcileKind(txn.amount) === "expense") {
    const rows = await prisma.expense.findMany({
      where: { orgId },
      orderBy: { date: "desc" },
      take: 100,
      select: {
        id: true,
        amount: true,
        date: true,
        vendor: true,
        category: true,
        description: true,
      },
    });
    return rows
      .sort(byCloseness)
      .slice(0, 25)
      .map((r) => ({
        id: r.id,
        kind: "expense" as const,
        amount: r.amount.toString(),
        date: r.date.toISOString(),
        label: r.vendor || r.category || r.description || "Expense",
      }));
  }

  const rows = await prisma.revenue.findMany({
    where: { orgId },
    orderBy: { date: "desc" },
    take: 100,
    select: { id: true, amount: true, date: true, client: true, description: true },
  });
  return rows
    .sort(byCloseness)
    .slice(0, 25)
    .map((r) => ({
      id: r.id,
      kind: "revenue" as const,
      amount: r.amount.toString(),
      date: r.date.toISOString(),
      label: r.client || r.description || "Revenue",
    }));
}

export async function excludeTransaction(orgId: string, txnId: string) {
  const txn = await loadReconcilable(orgId, txnId);
  return prisma.bankTransaction.update({
    where: { id: txn.id },
    data: { status: "EXCLUDED" },
  });
}
