import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const createProductSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().nullish(),
  sku: z.string().max(100).nullish(),
  price: z.number().optional(),
  currency: z.string().max(10).nullish(),
  status: z.string().nullish(),
  category: z.string().max(100).nullish(),
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
    const category = request.nextUrl.searchParams.get("category");
    const search = request.nextUrl.searchParams.get("search");

    const products = await prisma.product.findMany({
      where: {
        orgId,
        ...(status ? { status } : {}),
        ...(category ? { category } : {}),
        ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
      },
      include: {
        _count: { select: { contracts: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return success(products);
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
    const data = createProductSchema.parse(body);

    const product = await prisma.product.create({
      data: {
        orgId,
        name: data.name,
        description: data.description ?? null,
        sku: data.sku ?? null,
        price: data.price ?? null,
        currency: data.currency ?? "USD",
        status: data.status ?? "active",
        category: data.category ?? null,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "product.created",
      entity: "product",
      entityId: product.id,
      metadata: { name: data.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(product);
  } catch (error) {
    return handleApiError(error);
  }
}
