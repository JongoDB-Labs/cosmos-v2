import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireProjectRead, requireProjectVisible } from "@/lib/rbac/require-project-read";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { partnerSelect, mapVendorContract } from "@/lib/pm/vendor";
import { logPmActivity } from "@/lib/pm/activity-log";
import { canSeeProjectMoney, projectMoney, projectMoneyRows } from "@/lib/rbac/money-fields";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectRead(ctx, projectId, "ANALYTICS_READ");

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    // Largest-first is itself a statement about value, so a reader who may not
    // see the money gets the register in title order instead.
    const money = await canSeeProjectMoney(ctx, projectId);
    const contracts = await prisma.contract.findMany({
      where: { orgId, projectId },
      include: { partner: { select: partnerSelect } },
      orderBy: money ? { value: "desc" } : { title: "asc" },
    });

    return success(projectMoneyRows("vendor", contracts.map(mapVendorContract), money));
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  partnerId: z.string().uuid(),
  title: z.string().min(1).max(200),
  value: z.number().nullish(),
  fundedValue: z.number().nullish(),
  invoicedValue: z.number().nullish(),
  paymentTerms: z.string().max(120).nullish(),
  agmtType: z.string().max(40).nullish(),
  agmtNumber: z.string().max(80).nullish(),
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
    await requireProjectVisible(ctx, projectId);
    await requireProjectManage(ctx, projectId, Permission.PROJECT_UPDATE);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const data = createSchema.parse(await request.json());

    const partner = await prisma.partner.findFirst({ where: { id: data.partnerId, orgId } });
    if (!partner) return new Response("Partner not found", { status: 404 });

    const created = await prisma.contract.create({
      data: {
        orgId,
        projectId,
        partnerId: data.partnerId,
        title: data.title,
        value: data.value ?? null,
        fundedValue: data.fundedValue ?? null,
        invoicedValue: data.invoicedValue ?? null,
        paymentTerms: data.paymentTerms ?? null,
        agmtType: data.agmtType ?? null,
        agmtNumber: data.agmtNumber ?? null,
        currency: data.currency,
        status: data.status,
        startDate: data.startDate ? new Date(data.startDate) : null,
        endDate: data.endDate ? new Date(data.endDate) : null,
      },
      include: { partner: { select: partnerSelect } },
    });

    // The audit row names the record, never an amount (the audit log is read
    // without any finance permission).
    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "vendor.created",
      entity: "vendor_contract",
      entityId: created.id,
      metadata: { projectId, partnerId: data.partnerId },
      ipAddress: getIpAddress(request),
    });

    // Seed the activity log with a "created" event (best-effort).
    await logPmActivity({
      orgId,
      subjectType: "vendor",
      subjectId: created.id,
      userId: ctx.userId,
      action: "created",
    });

    return success(projectMoney("vendor", mapVendorContract(created), await canSeeProjectMoney(ctx, projectId)));
  } catch (e) {
    return handleApiError(e);
  }
}
