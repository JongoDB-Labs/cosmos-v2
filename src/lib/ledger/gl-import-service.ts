import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { trialBalance } from "./statements";
import { postEntry } from "./posting";
import { resolveAccount } from "./chart-of-accounts";
import { planGlImport, planToPostingLines, type SubmittedRow, type CurrentBalance, type GlImportPlan } from "./gl-import";

/**
 * The ledger's own position, in the shape the planner compares against.
 *
 * `trialBalance` already reports every account as of a date, so the current side
 * is read through the same code that renders the Trial Balance screen — an
 * import cannot disagree with the report it is reconciling against.
 */
export async function currentBalances(orgId: string, asOf: Date): Promise<CurrentBalance[]> {
  const tb = await trialBalance(orgId, asOf);
  return tb.rows.map((r) => ({
    code: r.code ?? "",
    name: r.name ?? "",
    balance: r.debit.minus(r.credit),
  }));
}

export type GlImportResult =
  | { posted: false; reason: "unchanged"; plan: GlImportPlan }
  | { posted: true; entryId: string; entryNumber: number; plan: GlImportPlan };

/**
 * Reconcile the ledger to a submitted trial balance as of `asOf`.
 *
 * Idempotent by ARITHMETIC rather than by a source key: the entry posted is the
 * difference between the submitted figures and the ledger's current position, so
 * running the same file twice computes a second delta of zero and posts nothing.
 * A source key would have been the obvious choice and the wrong one — `postEntry`
 * returns the existing entry for a repeated key, which would silently ignore a
 * CORRECTED re-import of the same period, the case that matters most.
 *
 * Closed periods are not special-cased here: `postEntry` refuses them, and an
 * import has no better claim on a closed month than anything else.
 */
export async function importTrialBalance(input: {
  orgId: string;
  asOf: Date;
  submitted: SubmittedRow[];
  createdById: string;
  memo?: string;
}): Promise<GlImportResult> {
  const current = await currentBalances(input.orgId, input.asOf);
  const plan = planGlImport(input.submitted, current);
  if (plan.unchanged && plan.residual.isZero()) {
    return { posted: false, reason: "unchanged", plan };
  }

  const postable = planToPostingLines(plan);
  const lines = await Promise.all(
    postable.map(async (l) => ({
      accountId: await resolveAccount(input.orgId, l.code),
      direction: l.direction,
      amount: l.amount as Prisma.Decimal,
    })),
  );

  const entry = await postEntry({
    orgId: input.orgId,
    date: input.asOf,
    memo: input.memo ?? `Trial balance import as of ${input.asOf.toISOString().slice(0, 10)}`,
    source: "GL_IMPORT",
    lines,
    createdById: input.createdById,
  });

  return { posted: true, entryId: entry.id, entryNumber: entry.entryNumber, plan };
}

/** Accounts the ledger knows, for the importer UI to map codes against. */
export async function knownAccountCodes(orgId: string): Promise<{ code: string; name: string }[]> {
  const rows = await prisma.account.findMany({
    where: { orgId, isActive: true },
    select: { code: true, name: true },
    orderBy: { code: "asc" },
  });
  return rows;
}
