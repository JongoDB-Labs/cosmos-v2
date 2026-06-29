import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

const partnerSelect = {
  id: true,
  name: true,
  type: true,
  status: true,
  socioEconomic: true,
  cageCode: true,
  perfRating: true,
} as const;

function mapContract(c: {
  id: string;
  partnerId: string | null;
  partner: {
    id: string;
    name: string;
    type: string;
    status: string;
    socioEconomic: string | null;
    cageCode: string | null;
    perfRating: number | null;
  } | null;
  title: string;
  value: { toNumber(): number } | null;
  currency: string;
  status: string;
  startDate: Date | null;
  endDate: Date | null;
}) {
  return {
    id: c.id,
    partnerId: c.partnerId,
    partner: c.partner,
    title: c.title,
    value: c.value != null ? Number(c.value) : null,
    currency: c.currency,
    status: c.status,
    startDate: c.startDate ? c.startDate.toISOString() : null,
    endDate: c.endDate ? c.endDate.toISOString() : null,
  };
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ANALYTICS_READ);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const contracts = await prisma.contract.findMany({
      where: { orgId, projectId },
      include: { partner: { select: partnerSelect } },
      orderBy: { value: "desc" },
    });

    return success(contracts.map(mapContract));
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  partnerId: z.string().uuid(),
  title: z.string().min(1).max(200),
  value: z.number().nullish(),
  currency: z.string().default("USD"),
  status: z.string().default("active"),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const data = createSchema.parse(await request.json());

    // Verify the partner belongs to this org.
    const partner = await prisma.partner.findFirst({ where: { id: data.partnerId, orgId } });
    if (!partner) return new Response("Partner not found", { status: 404 });

    const created = await prisma.contract.create({
      data: {
        orgId,
        projectId,
        partnerId: data.partnerId,
        title: data.title,
        value: data.value ?? null,
        currency: data.currency,
        status: data.status,
        startDate: data.startDate ? new Date(data.startDate) : null,
        endDate: data.endDate ? new Date(data.endDate) : null,
      },
      include: { partner: { select: partnerSelect } },
    });

    return success(mapContract(created));
  } catch (e) {
    return handleApiError(e);
  }
}
