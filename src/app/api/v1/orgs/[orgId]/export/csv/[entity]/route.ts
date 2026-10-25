// SCOPING NOTE — filtered by project visibility, like every other read.
//
// This was deliberately org-wide while teamScopedAccess was a visibility
// default, "to revisit if it is ever promoted to a hard boundary". It has been:
// no read or write reaches a team-scoped project its caller can't see. Org
// owners and admins (the default holders of ORG_EXPORT) see every project, so
// their exports are whole; a work role granting ORG_EXPORT to someone else
// exports what that person can see. Records under no project are org-wide.
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { hiddenProjectIds } from "@/lib/rbac/project-access";
import { handleApiError } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { toCSV } from "@/lib/export/csv";
import { NOT_VOIDED } from "@/lib/time/not-voided";

type RouteParams = { params: Promise<{ orgId: string; entity: string }> };

/** Rows of a project the exporter can't see are left out (see the note above). */
const inVisible = (hidden: string[]) => (hidden.length ? { projectId: { notIn: hidden } } : {});
/** The same for a record that may belong to no project, which stays in. */
const noneOrVisible = (hidden: string[]) =>
  hidden.length ? { OR: [{ projectId: null }, { projectId: { notIn: hidden } }] } : {};


// Allowlist of entity slugs → Prisma model accessor
const FETCHERS: Record<string, (orgId: string, hidden: string[]) => Promise<unknown[]>> = {
  projects: (orgId, hidden) => prisma.project.findMany({ where: { orgId, ...(hidden.length ? { id: { notIn: hidden } } : {}) } }),
  "work-items": (orgId, hidden) => prisma.workItem.findMany({ where: { orgId, ...inVisible(hidden) } }).catch(() => []),
  intervals: (orgId, hidden) => prisma.interval.findMany({ where: { orgId, ...inVisible(hidden) } }).catch(() => []),
  "crm-contacts": (orgId) => prisma.crmContact.findMany({ where: { orgId } }).catch(() => []),
  partners: (orgId) => prisma.partner.findMany({ where: { orgId } }).catch(() => []),
  products: (orgId) => prisma.product.findMany({ where: { orgId } }).catch(() => []),
  contracts: (orgId, hidden) => prisma.contract.findMany({ where: { orgId, ...noneOrVisible(hidden) } }).catch(() => []),
  notes: (orgId) => prisma.note.findMany({ where: { orgId } }).catch(() => []),
  meetings: (orgId, hidden) => prisma.syncMeeting.findMany({ where: { orgId, ...noneOrVisible(hidden) } }).catch(() => []),
  "time-entries": (orgId, hidden) =>
    prisma.timeEntry.findMany({ where: { orgId, ...NOT_VOIDED, ...noneOrVisible(hidden) } }).catch(() => []),
  revenues: (orgId) => prisma.revenue.findMany({ where: { orgId } }).catch(() => []),
  expenses: (orgId, hidden) => prisma.expense.findMany({ where: { orgId, ...noneOrVisible(hidden) } }).catch(() => []),
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

    const rows = await fetcher(ctx.orgId, await hiddenProjectIds(ctx));
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
