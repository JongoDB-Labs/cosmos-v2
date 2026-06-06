import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";

type RouteParams = { params: Promise<{ orgId: string }> };

// JSON.stringify can't serialize BigInt — convert to string
function jsonStringifySafe(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_EXPORT);

    const limited = checkRateLimit(request, "export.json", ctx.userId, {
      capacity: 5,
      refillPerSecond: 0.1,
    });
    if (limited) return limited;

    // Deep export — all entities scoped to this org
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      organization: await prisma.organization.findUnique({ where: { id: ctx.orgId } }),
      members: await prisma.orgMember.findMany({ where: { orgId: ctx.orgId }, include: { user: true } }),
      projects: await prisma.project.findMany({ where: { orgId: ctx.orgId } }),
      workItems: await prisma.workItem.findMany({ where: { orgId: ctx.orgId } }).catch(() => []),
      cycles: await prisma.cycle.findMany({ where: { orgId: ctx.orgId } }).catch(() => []),
      crmContacts: await prisma.crmContact.findMany({ where: { orgId: ctx.orgId } }).catch(() => []),
      partners: await prisma.partner.findMany({ where: { orgId: ctx.orgId } }).catch(() => []),
      products: await prisma.product.findMany({ where: { orgId: ctx.orgId } }).catch(() => []),
      contracts: await prisma.contract.findMany({ where: { orgId: ctx.orgId } }).catch(() => []),
      notes: await prisma.note.findMany({ where: { orgId: ctx.orgId } }).catch(() => []),
      meetings: await prisma.syncMeeting.findMany({ where: { orgId: ctx.orgId } }).catch(() => []),
      timeEntries: await prisma.timeEntry.findMany({ where: { orgId: ctx.orgId } }).catch(() => []),
      revenues: await prisma.revenue.findMany({ where: { orgId: ctx.orgId } }).catch(() => []),
      expenses: await prisma.expense.findMany({ where: { orgId: ctx.orgId } }).catch(() => []),
    };

    return new NextResponse(jsonStringifySafe(data), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="cosmos-${org.slug}-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
