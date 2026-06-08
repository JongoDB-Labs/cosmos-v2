import { createHash } from "crypto";
import { prisma } from "@/lib/db/client";
import type { ParsedTxn } from "./types";
import { applyRules } from "./rules";

/** Stable dedup fingerprint for transactions lacking a reliable FITID. */
export function fingerprintTxn(bankAccountId: string, t: ParsedTxn): string {
  return createHash("sha256")
    .update(
      `${bankAccountId}|${t.postedDate.toISOString().slice(0, 10)}|${t.amount.toString()}|${t.description}`,
    )
    .digest("hex");
}

/** Persist parsed transactions, deduped by (externalId) and (fingerprint). Returns counts. */
export async function importTransactions(
  orgId: string,
  bankAccountId: string,
  parsed: ParsedTxn[],
): Promise<{ imported: number; skipped: number }> {
  if (parsed.length === 0) return { imported: 0, skipped: 0 };

  // Active rules, highest precedence first — the first match pre-fills the txn's
  // category (a suggestion; the txn still lands IMPORTED for the user to review).
  const rules = await prisma.bankRule.findMany({
    where: { orgId, isActive: true },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    select: {
      descriptionContains: true,
      direction: true,
      amountMin: true,
      amountMax: true,
      category: true,
    },
  });

  const data = parsed.map((t) => ({
    orgId,
    bankAccountId,
    externalId: t.externalId,
    fingerprint: fingerprintTxn(bankAccountId, t),
    postedDate: t.postedDate,
    amount: t.amount,
    description: t.description,
    category: applyRules(rules, { description: t.description, amount: t.amount }),
  }));

  const res = await prisma.bankTransaction.createMany({ data, skipDuplicates: true });
  return { imported: res.count, skipped: data.length - res.count };
}
