import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { toCSV } from "@/lib/export/csv";

type RouteParams = { params: Promise<{ orgId: string; entity: string }> };

// Allowlist of entity slugs → Prisma model accessor
const FETCHERS: Record<string, (orgId: string) => Promise<unknown[]>> = {
  projects: (orgId) => prisma.project.findMany({ where: { orgId } }),
  "work-items": (orgId) => prisma.workItem.findMany({ where: { orgId } }).catch(() => []),
  intervals: (orgId) => prisma.interval.findMany({ where: { orgId } }).catch(() => []),
  "crm-contacts": (orgId) => prisma.crmContact.findMany({ where: { orgId } }).catch(() => []),
  partners: (orgId) => prisma.partner.findMany({ where: { orgId } }).catch(() => []),
  products: (orgId) => prisma.product.findMany({ where: { orgId } }).catch(() => []),
  contracts: (orgId) => prisma.contract.findMany({ where: { orgId } }).catch(() => []),
  notes: (orgId) => prisma.note.findMany({ where: { orgId } }).catch(() => []),
  meetings: (orgId) => prisma.syncMeeting.findMany({ where: { orgId } }).catch(() => []),
  "time-entries": (orgId) => prisma.timeEntry.findMany({ where: { orgId } }).catch(() => []),
  revenues: (orgId) => prisma.revenue.findMany({ where: { orgId } }).catch(() => []),
  expenses: (orgId) => prisma.expense.findMany({ where: { orgId } }).catch(() => []),
};

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, entity } = await params;
    const fetcher = FETCHERS[entity];
    if (!fetcher) return new Response("Unknown entity", { status: 400 });

    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_EXPORT);

    const limited = checkRateLimit(request, "export.csv", ctx.userId, {
      capacity: 10,
      refillPerSecond: 0.2,
    });
    if (limited) return limited;

    const rows = await fetcher(ctx.orgId);
    const csv = toCSV(rows as Record<string, unknown>[]);

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${entity}-${org.slug}-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
