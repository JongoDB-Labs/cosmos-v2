import { Permission } from "@/lib/rbac/permissions";
import { trialBalance, profitAndLoss } from "@/lib/ledger/statements";
import { moneyToNumber } from "@/lib/money";
import { assertPermission, type ToolContext } from "./_ctx";

export async function getTrialBalance(_input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ACCOUNTING_READ);
  if (denied) return denied;
  const tb = await trialBalance(ctx.orgId);
  return {
    totalDebits: moneyToNumber(tb.totalDebits),
    totalCredits: moneyToNumber(tb.totalCredits),
    accounts: tb.rows.length,
    balanced: tb.totalDebits.equals(tb.totalCredits),
  };
}

export async function getProfitAndLoss(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ACCOUNTING_READ);
  if (denied) return denied;
  const from = typeof input.startDate === "string" ? new Date(input.startDate) : undefined;
  const to = typeof input.endDate === "string" ? new Date(input.endDate) : undefined;
  const pl = await profitAndLoss(ctx.orgId, from, to);
  return {
    revenue: moneyToNumber(pl.revenue),
    expense: moneyToNumber(pl.expense),
    netIncome: moneyToNumber(pl.netIncome),
  };
}
