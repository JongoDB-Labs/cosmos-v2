import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { sumMoney, multiplyMoney, moneyToNumber } from "@/lib/money";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_READ);

    const sp = request.nextUrl.searchParams;
    const startDate = sp.get("startDate");
    const endDate = sp.get("endDate");

    const dateFilter = {
      ...(startDate ? { gte: new Date(startDate) } : {}),
      ...(endDate ? { lte: new Date(endDate) } : {}),
    };
    const hasDateFilter = startDate || endDate;

    const revenueWhere: Record<string, unknown> = { orgId };
    const expenseWhere: Record<string, unknown> = { orgId };
    const timeWhere: Record<string, unknown> = { orgId };
    if (hasDateFilter) {
      revenueWhere.date = dateFilter;
      expenseWhere.date = dateFilter;
      timeWhere.date = dateFilter;
    }

    const [revenues, expenses, timeEntries] = await Promise.all([
      prisma.revenue.findMany({ where: revenueWhere }),
      prisma.expense.findMany({ where: expenseWhere }),
      prisma.timeEntry.findMany({
        where: { ...timeWhere, status: "APPROVED" },
      }),
    ]);

    const totalRevenue = sumMoney(revenues.map((r) => r.amount));
    const totalExpenses = sumMoney(expenses.map((e) => e.amount));
    const netIncome = totalRevenue.minus(totalExpenses);

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
      const monthRevenue = sumMoney(revenues.filter((r) => r.date >= monthStart && r.date <= monthEnd).map((r) => r.amount));
      const monthExpenses = sumMoney(expenses.filter((e) => e.date >= monthStart && e.date <= monthEnd).map((e) => e.amount));
      monthlyTrend.push({ month: monthKey, revenue: moneyToNumber(monthRevenue), expenses: moneyToNumber(monthExpenses) });
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

    return success({
      totalRevenue: moneyToNumber(totalRevenue),
      totalExpenses: moneyToNumber(totalExpenses),
      netIncome: moneyToNumber(netIncome),
      revenueByType,
      expensesByCategory,
      monthlyTrend,
      billableHours,
      nonBillableHours,
      billableAmount: moneyToNumber(billableAmount),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
