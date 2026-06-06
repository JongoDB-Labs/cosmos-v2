import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { moneyToNumber } from "@/lib/money";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CRM_READ);

    const contacts = await prisma.crmContact.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
    });

    const stageMap: Record<string, { contacts: typeof contacts; totalDealValue: Prisma.Decimal }> = {};

    for (const contact of contacts) {
      if (!stageMap[contact.stage]) {
        stageMap[contact.stage] = { contacts: [], totalDealValue: new Prisma.Decimal(0) };
      }
      stageMap[contact.stage].contacts.push(contact);
      if (contact.dealValue != null) stageMap[contact.stage].totalDealValue = stageMap[contact.stage].totalDealValue.plus(contact.dealValue);
    }

    const pipeline = Object.entries(stageMap).map(([stage, data]) => ({
      stage,
      count: data.contacts.length,
      totalDealValue: moneyToNumber(data.totalDealValue),
      contacts: data.contacts,
    }));

    return success(pipeline);
  } catch (error) {
    return handleApiError(error);
  }
}
