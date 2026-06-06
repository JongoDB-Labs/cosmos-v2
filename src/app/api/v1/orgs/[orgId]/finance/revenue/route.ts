import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { RevenueType } from "@prisma/client";
import { safeAutoPost, postRevenueToLedger } from "@/lib/ledger/auto-post";

const createRevenueSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().max(10).nullish(),
  date: z.string(),
  client: z.string().nullish(),
  product: z.string().nullish(),
  type: z.nativeEnum(RevenueType).optional(),
  description: z.string().nullish(),
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
    const type = sp.get("type");
    const startDate = sp.get("startDate");
    const endDate = sp.get("endDate");
    const client = sp.get("client");

    const where: Record<string, unknown> = { orgId };
    if (type) where.type = type;
    if (client) where.client = client;
    if (startDate || endDate) {
      where.date = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {}),
      };
    }

    const [revenues, total] = await Promise.all([
      prisma.revenue.findMany({
        where,
        orderBy: { date: "desc" },
      }),
      prisma.revenue.count({ where }),
    ]);

    return success({ data: revenues, total });
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
    const data = createRevenueSchema.parse(body);

    const revenue = await prisma.revenue.create({
      data: {
        orgId,
        amount: data.amount,
        currency: data.currency ?? "USD",
        date: new Date(data.date),
        client: data.client ?? null,
        product: data.product ?? null,
        type: data.type ?? "ONE_TIME",
        description: data.description ?? "",
        createdById: ctx.userId,
      },
    });

    await safeAutoPost(() => postRevenueToLedger(revenue), `revenue ${revenue.id}`);

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "revenue.created",
      entity: "revenue",
      entityId: revenue.id,
      metadata: { amount: String(data.amount), type: data.type ?? "ONE_TIME" } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(revenue);
  } catch (error) {
    return handleApiError(error);
  }
}
