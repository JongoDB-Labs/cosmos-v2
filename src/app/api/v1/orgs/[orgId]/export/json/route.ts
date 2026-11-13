// SCOPING NOTE — filtered by project visibility, like every other read.
//
// This was deliberately org-wide while teamScopedAccess was a visibility
// default, "to revisit if it is ever promoted to a hard boundary". It has been:
// no read or write reaches a team-scoped project its caller can't see. Org
// owners and admins (the default holders of ORG_EXPORT) see every project, so
// their exports are whole; a work role granting ORG_EXPORT to someone else
// exports what that person can see. Records under no project are org-wide.
import { NextResponse, type NextRequest } from "next/server";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { hiddenProjectIds } from "@/lib/rbac/project-access";
import { readableContractsWhere } from "@/lib/crm/contract-scope";
import { getIpAddress, handleApiError } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { NOT_VOIDED } from "@/lib/time/not-voided";
import {
  EXPORT_MEMBER_SELECT,
  EXPORT_ORG_SELECT,
  auditExport,
  exportEntity,
  exportableContracts,
  exportableMember,
  exportableNotesWhere,
  exportableTime,
  mayExportFinance,
  mayExportSettings,
} from "@/lib/export/org-export-scope";

type RouteParams = { params: Promise<{ orgId: string }> };

/** Who a member is, never how they sign in. A new User column stays out until listed here. */
const EXPORTED_USER = {
  id: true,
  email: true,
  displayName: true,
  avatarUrl: true,
  isBot: true,
  mfaEnabled: true,
  createdAt: true,
  deactivatedAt: true,
  lastActiveAt: true,
} as const;

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

    // Deep export — all entities scoped to this org, less any project the
    // exporter can't see (see the note above).
    const hidden = await hiddenProjectIds(ctx);
    const inVisible = hidden.length ? { projectId: { notIn: hidden } } : {};
    const noneOrVisible = hidden.length ? { OR: [{ projectId: null }, { projectId: { notIn: hidden } }] } : {};
    // What each entity may carry is decided in lib/export/org-export-scope.ts,
    // shared with the CSV export. Revenues and expenses are left OUT for an
    // exporter without finance access, not exported as empty lists: an empty
    // list reads as "this org has none".
    const finance = mayExportFinance(ctx);
    const where = { orgId: ctx.orgId };
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      organization: await exportEntity(
        "the organization",
        prisma.organization.findUnique({
          where: { id: ctx.orgId },
          select: { ...EXPORT_ORG_SELECT, settings: mayExportSettings(ctx) },
        }),
      ),
      // Unfiltered on purpose: this is a whole-org archive, so it carries people who
      // have since been removed as well as current members. `removedAt` tells them
      // apart — dropping them would make the export disagree with the history it is
      // exported alongside.
      //
      // The user record is selected column by column (EXPORTED_USER, above):
      // loaded whole it carried each person's password hash and sealed MFA
      // secret into the archive.
      members: (
        await exportEntity(
          "members",
          prismaUnfiltered.orgMember.findMany({ where, select: { ...EXPORT_MEMBER_SELECT, user: { select: EXPORTED_USER } } }),
        )
      ).map(exportableMember),
      // Narrowed: `hidden` is hiddenProjectIds(ctx), above.
      projects: await exportEntity(
        "projects",
        prisma.project.findMany({ where: { ...where, ...(hidden.length ? { id: { notIn: hidden } } : {}) } }),
      ),
      workItems: await exportEntity("work items", prisma.workItem.findMany({ where: { ...where, ...inVisible } })),
      intervals: await exportEntity("intervals", prisma.interval.findMany({ where: { ...where, ...inVisible } })),
      crmContacts: await exportEntity("CRM contacts", prisma.crmContact.findMany({ where })),
      partners: await exportEntity("partners", prisma.partner.findMany({ where })),
      products: await exportEntity("products", prisma.product.findMany({ where })),
      // The contract list's rule (lib/crm/contract-scope.ts), not only project
      // visibility: a rule denying CRM data on a project keeps its contracts out.
      contracts: await exportableContracts(
        ctx,
        await exportEntity("contracts", readableContractsWhere(ctx).then((where) => prisma.contract.findMany({ where }))),
      ),
      notes: await exportEntity(
        "notes",
        prisma.note.findMany({ where: { ...where, ...exportableNotesWhere(ctx.userId) } }),
      ),
      meetings: await exportEntity("meetings", prisma.syncMeeting.findMany({ where: { ...where, ...noneOrVisible } })),
      timeEntries: exportableTime(
        ctx,
        await exportEntity(
          "time entries",
          prisma.timeEntry.findMany({ where: { ...where, ...NOT_VOIDED, ...noneOrVisible } }),
        ),
      ),
      ...(finance && {
        revenues: await exportEntity("revenues", prisma.revenue.findMany({ where })),
        expenses: await exportEntity("expenses", prisma.expense.findMany({ where: { ...where, ...noneOrVisible } })),
      }),
    };

    await auditExport(ctx, {
      format: "json",
      entities: Object.keys(data).filter((k) => Array.isArray((data as Record<string, unknown>)[k])),
      ipAddress: getIpAddress(request),
    });

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
