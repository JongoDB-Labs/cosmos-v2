import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const createPartnerSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.string().nullish(),
  status: z.string().nullish(),
  website: z.string().url().nullish().or(z.literal("")),
  contactName: z.string().max(200).nullish(),
  contactEmail: z.string().email().nullish().or(z.literal("")),
  contactPhone: z.string().max(50).nullish(),
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
    const search = request.nextUrl.searchParams.get("search");

    const partners = await prisma.partner.findMany({
      where: {
        orgId,
        ...(status ? { status } : {}),
        ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
      },
      include: {
        _count: { select: { contracts: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return success(partners);
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
    const data = createPartnerSchema.parse(body);

    const partner = await prisma.partner.create({
      data: {
        orgId,
        name: data.name,
        type: data.type ?? "vendor",
        status: data.status ?? "active",
        website: data.website || null,
        contactName: data.contactName ?? null,
        contactEmail: data.contactEmail || null,
        contactPhone: data.contactPhone ?? null,
        notes: data.notes ?? null,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "partner.created",
      entity: "partner",
      entityId: partner.id,
      metadata: { name: data.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(partner);
  } catch (error) {
    return handleApiError(error);
  }
}
