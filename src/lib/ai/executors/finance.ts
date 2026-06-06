import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { Prisma, RevenueType } from "@prisma/client";
import { z } from "zod";
import { assertPermission, type ToolContext } from "./_ctx";
import { sumMoney, multiplyMoney, moneyToNumber } from "@/lib/money";
import { safeAutoPost, postRevenueToLedger } from "@/lib/ledger/auto-post";

const logRevenueSchema = z.object({
  amount: z.number().positive(),
  date: z.string().min(1),
  currency: z.string().max(10).optional(),
  client: z.string().optional(),
  product: z.string().optional(),
  description: z.string().optional(),
  type: z.nativeEnum(RevenueType).optional(),
});

const logExpenseSchema = z.object({
  amount: z.number().positive(),
  date: z.string().min(1),
  currency: z.string().max(10).optional(),
  category: z.string().min(1),
  vendor: z.string().optional(),
  description: z.string().optional(),
  recurring: z.boolean().optional(),
});

const summarySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export async function logRevenue(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.FINANCE_MANAGE);
  if (denied) return denied;

  const parsed = logRevenueSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  const revenue = await prisma.revenue.create({
    data: {
      orgId: ctx.orgId,
      amount: data.amount,
      currency: data.currency ?? "USD",
      date: new Date(data.date),
      client: data.client ?? null,
      product: data.product ?? null,
      type: data.type ?? RevenueType.ONE_TIME,
      description: data.description ?? "",
      createdById: ctx.userId,
    },
  });
  await safeAutoPost(() => postRevenueToLedger(revenue), `revenue ${revenue.id}`);

  return {
    created: true,
    id: revenue.id,
    amount: moneyToNumber(revenue.amount),
    currency: revenue.currency,
    date: revenue.date,
    type: revenue.type,
  };
}

export async function logExpense(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.FINANCE_MANAGE);
  if (denied) return denied;

  const parsed = logExpenseSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  const expense = await prisma.expense.create({
    data: {
      orgId: ctx.orgId,
      amount: data.amount,
      currency: data.currency ?? "USD",
      date: new Date(data.date),
      category: data.category,
      vendor: data.vendor ?? null,
      description: data.description ?? "",
      recurring: data.recurring ?? false,
      createdById: ctx.userId,
    },
  });
  return {
    created: true,
    id: expense.id,
    amount: moneyToNumber(expense.amount),
    category: expense.category,
    date: expense.date,
  };
}

export async function getFinanceSummary(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.FINANCE_READ);
  if (denied) return denied;

  const parsed = summarySchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const { startDate, endDate } = parsed.data;

  const dateFilter = {
    ...(startDate ? { gte: new Date(startDate) } : {}),
    ...(endDate ? { lte: new Date(endDate) } : {}),
  };
  const hasDateFilter = Object.keys(dateFilter).length > 0;

  const revWhere: Record<string, unknown> = { orgId: ctx.orgId };
  const expWhere: Record<string, unknown> = { orgId: ctx.orgId };
  const timeWhere: Record<string, unknown> = { orgId: ctx.orgId, status: "APPROVED" };
  if (hasDateFilter) {
    revWhere.date = dateFilter;
    expWhere.date = dateFilter;
    timeWhere.date = dateFilter;
  }

  const [revenues, expenses, timeEntries] = await Promise.all([
    prisma.revenue.findMany({ where: revWhere }),
    prisma.expense.findMany({ where: expWhere }),
    prisma.timeEntry.findMany({ where: timeWhere }),
  ]);

  const totalRevenue = sumMoney(revenues.map((r) => r.amount));
  const totalExpenses = sumMoney(expenses.map((e) => e.amount));

  const revByType = new Map<string, Prisma.Decimal>();
  for (const r of revenues) revByType.set(r.type, (revByType.get(r.type) ?? new Prisma.Decimal(0)).plus(r.amount));
  const revenueByType = Object.fromEntries([...revByType].map(([k, v]) => [k, moneyToNumber(v)]));

  const expByCat = new Map<string, Prisma.Decimal>();
  for (const e of expenses) expByCat.set(e.category, (expByCat.get(e.category) ?? new Prisma.Decimal(0)).plus(e.amount));
  const expensesByCategory = Object.fromEntries([...expByCat].map(([k, v]) => [k, moneyToNumber(v)]));

  const now = new Date();
  const monthlyTrend: Array<{ month: string; revenue: number; expenses: number }> = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
    const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const mRev = sumMoney(revenues.filter((r) => r.date >= monthStart && r.date <= monthEnd).map((r) => r.amount));
    const mExp = sumMoney(expenses.filter((e) => e.date >= monthStart && e.date <= monthEnd).map((e) => e.amount));
    monthlyTrend.push({ month: monthKey, revenue: moneyToNumber(mRev), expenses: moneyToNumber(mExp) });
  }

  let billableHours = 0;
  let nonBillableHours = 0;
  const billableAmounts: Prisma.Decimal[] = [];
  for (const t of timeEntries) {
    if (t.billableType === "BILLABLE") {
      billableHours += t.hours;
      billableAmounts.push(multiplyMoney(t.rate, t.hours));
    } else {
      nonBillableHours += t.hours;
    }
  }
  const billableAmount = sumMoney(billableAmounts);

  return {
    totalRevenue: moneyToNumber(totalRevenue),
    totalExpenses: moneyToNumber(totalExpenses),
    netIncome: moneyToNumber(totalRevenue.minus(totalExpenses)),
    revenueByType,
    expensesByCategory,
    monthlyTrend,
    billableHours,
    nonBillableHours,
    billableAmount: moneyToNumber(billableAmount),
  };
}
