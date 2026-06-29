import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const createExpenseSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().max(10).nullish(),
  date: z.string(),
  category: z.string().min(1),
  vendor: z.string().nullish(),
  description: z.string().nullish(),
  recurring: z.boolean().optional(),
  clinId: z.string().uuid().nullish(),
});

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
    const category = sp.get("category");
    const startDate = sp.get("startDate");
    const endDate = sp.get("endDate");
    const vendor = sp.get("vendor");
    const recurring = sp.get("recurring");
    const status = sp.get("status");

    const where: Record<string, unknown> = { orgId };
    if (category) where.category = category;
    if (vendor) where.vendor = vendor;
    if (status && ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"].includes(status)) {
      where.status = status;
    }
    if (recurring !== null && recurring !== undefined && recurring !== "") {
      where.recurring = recurring === "true";
    }
    if (startDate || endDate) {
      where.date = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {}),
      };
    }

    const [expenses, total] = await Promise.all([
      prisma.expense.findMany({
        where,
        orderBy: { date: "desc" },
      }),
      prisma.expense.count({ where }),
    ]);

    return success({ data: expenses, total });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_MANAGE);

    const body = await request.json();
    const data = createExpenseSchema.parse(body);

    const expense = await prisma.expense.create({
      data: {
        orgId,
        amount: data.amount,
        currency: data.currency ?? "USD",
        date: new Date(data.date),
        category: data.category,
        vendor: data.vendor ?? null,
        description: data.description ?? "",
        recurring: data.recurring ?? false,
        clinId: data.clinId ?? null,
        createdById: ctx.userId,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "expense.created",
      entity: "expense",
      entityId: expense.id,
      metadata: { amount: String(data.amount), category: data.category } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(expense);
  } catch (error) {
    return handleApiError(error);
  }
}
