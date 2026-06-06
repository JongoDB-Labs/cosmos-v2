import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const createContractSchema = z.object({
  title: z.string().min(1).max(500),
  partnerId: z.string().uuid().nullish(),
  productId: z.string().uuid().nullish(),
  value: z.number().optional(),
  currency: z.string().max(10).nullish(),
  status: z.string().nullish(),
  startDate: z.string().datetime().nullish(),
  endDate: z.string().datetime().nullish(),
  terms: z.string().nullish(),
  notes: z.string().nullish(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CRM_READ);

    const status = request.nextUrl.searchParams.get("status");
    const partnerId = request.nextUrl.searchParams.get("partnerId");
    const productId = request.nextUrl.searchParams.get("productId");

    const contracts = await prisma.contract.findMany({
      where: {
        orgId,
        ...(status ? { status } : {}),
        ...(partnerId ? { partnerId } : {}),
        ...(productId ? { productId } : {}),
      },
      include: {
        partner: true,
        product: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return success(contracts);
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
    requirePermission(ctx, Permission.CRM_CREATE);

    const body = await request.json();
    const data = createContractSchema.parse(body);

    const contract = await prisma.contract.create({
      data: {
        orgId,
        title: data.title,
        partnerId: data.partnerId ?? null,
        productId: data.productId ?? null,
        value: data.value ?? null,
        currency: data.currency ?? "USD",
        status: data.status ?? "draft",
        startDate: data.startDate ? new Date(data.startDate) : null,
        endDate: data.endDate ? new Date(data.endDate) : null,
        terms: data.terms ?? null,
        notes: data.notes ?? null,
      },
      include: {
        partner: true,
        product: true,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "contract.created",
      entity: "contract",
      entityId: contract.id,
      metadata: { title: data.title } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(contract);
  } catch (error) {
    return handleApiError(error);
  }
}
