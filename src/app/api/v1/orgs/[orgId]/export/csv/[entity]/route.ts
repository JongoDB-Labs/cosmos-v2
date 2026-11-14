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
import { ForbiddenError, requirePermission, type AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { hiddenProjectIds } from "@/lib/rbac/project-access";
import { readableContractsWhere } from "@/lib/crm/contract-scope";
import { readableMeetingsWhere } from "@/lib/meetings/meeting-reader";
import { getIpAddress, handleApiError } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { toCSV } from "@/lib/export/csv";
import { NOT_VOIDED } from "@/lib/time/not-voided";
import {
  auditExport,
  exportEntity,
  exportableContracts,
  exportableNotesWhere,
  exportableProjectRowsWhere,
  exportableTime,
  mayExportEntity,
  type ExportEntity,
} from "@/lib/export/org-export-scope";

type RouteParams = { params: Promise<{ orgId: string; entity: string }> };

/** A record of a project the exporter can't see is left out; one under no project stays in. */
const noneOrVisible = (hidden: string[]) =>
  hidden.length ? { OR: [{ projectId: null }, { projectId: { notIn: hidden } }] } : {};

type Fetch = (orgId: string, hidden: string[], ctx: AuthContext) => Promise<unknown[]>;

// Allowlist of entity slugs → the entity it is (whose list's bit it asks for)
// and how its rows are read. What each may carry is decided in
// lib/export/org-export-scope.ts, shared with the JSON archive.
const FETCHERS: Record<string, { entity: ExportEntity; fetch: Fetch }> = {
  // SCOPING NOTE — `hidden` is hiddenProjectIds(ctx), which GET passes in.
  projects: {
    entity: "projects",
    fetch: (orgId, hidden) =>
      exportEntity("projects", prisma.project.findMany({ where: { orgId, ...(hidden.length ? { id: { notIn: hidden } } : {}) } })),
  },
  // From the projects their own lists read them from, not visibility alone.
  "work-items": {
    entity: "workItems",
    fetch: (orgId, _hidden, ctx) =>
      exportEntity(
        "work items",
        exportableProjectRowsWhere(ctx, "workItems").then((scope) => prisma.workItem.findMany({ where: { orgId, ...scope } })),
      ),
  },
  intervals: {
    entity: "intervals",
    fetch: (orgId, _hidden, ctx) =>
      exportEntity(
        "intervals",
        exportableProjectRowsWhere(ctx, "intervals").then((scope) => prisma.interval.findMany({ where: { orgId, ...scope } })),
      ),
  },
  "crm-contacts": {
    entity: "crmContacts",
    fetch: (orgId) => exportEntity("CRM contacts", prisma.crmContact.findMany({ where: { orgId } })),
  },
  partners: { entity: "partners", fetch: (orgId) => exportEntity("partners", prisma.partner.findMany({ where: { orgId } })) },
  products: { entity: "products", fetch: (orgId) => exportEntity("products", prisma.product.findMany({ where: { orgId } })) },
  // The contract list's rule, not just project visibility: CRM_READ on each
  // contract's project, so a rule denying CRM data there keeps it out too.
  contracts: {
    entity: "contracts",
    fetch: async (_orgId, _hidden, ctx) =>
      exportableContracts(ctx, await exportEntity("contracts", readableContractsWhere(ctx).then((where) => prisma.contract.findMany({ where })))),
  },
  notes: {
    entity: "notes",
    fetch: (orgId, _hidden, ctx) =>
      exportEntity("notes", prisma.note.findMany({ where: { orgId, ...exportableNotesWhere(ctx.userId) } })),
  },
  // The meeting list's rule (lib/meetings/meeting-reader.ts), policies included.
  meetings: {
    entity: "meetings",
    fetch: (_orgId, _hidden, ctx) =>
      exportEntity("meetings", readableMeetingsWhere(ctx).then((where) => prisma.syncMeeting.findMany({ where }))),
  },
  "time-entries": {
    entity: "timeEntries",
    fetch: async (orgId, hidden, ctx) =>
      exportableTime(
        ctx,
        await exportEntity("time entries", prisma.timeEntry.findMany({ where: { orgId, ...NOT_VOIDED, ...noneOrVisible(hidden) } })),
      ),
  },
  revenues: { entity: "revenues", fetch: (orgId) => exportEntity("revenues", prisma.revenue.findMany({ where: { orgId } })) },
  expenses: {
    entity: "expenses",
    fetch: (orgId, hidden) => exportEntity("expenses", prisma.expense.findMany({ where: { orgId, ...noneOrVisible(hidden) } })),
  },
};

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, entity } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_EXPORT);

    // After authenticating: only a caller who may export learns which entities exist.
    const fetcher = Object.hasOwn(FETCHERS, entity) ? FETCHERS[entity] : undefined;
    if (!fetcher) return new Response("Unknown entity", { status: 400 });
    // Refused outright, like the list it comes from, rather than exported empty.
    if (!mayExportEntity(ctx, fetcher.entity)) throw new ForbiddenError(`Exporting ${entity} needs access to read it`);

    const limited = checkRateLimit(request, "export.csv", ctx.userId, {
      capacity: 10,
      refillPerSecond: 0.2,
    });
    if (limited) return limited;

    const rows = await fetcher.fetch(ctx.orgId, await hiddenProjectIds(ctx), ctx);
    const csv = toCSV(rows as Record<string, unknown>[]);
    await auditExport(ctx, { format: "csv", entities: [entity], ipAddress: getIpAddress(request) });

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
