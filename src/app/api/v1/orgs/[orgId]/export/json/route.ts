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
import { handleApiError } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { NOT_VOIDED } from "@/lib/time/not-voided";

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

    // Deep export — all entities scoped to this org, less any project the
    // exporter can't see (see the note above).
    const hidden = await hiddenProjectIds(ctx);
    const inVisible = hidden.length ? { projectId: { notIn: hidden } } : {};
    const noneOrVisible = hidden.length ? { OR: [{ projectId: null }, { projectId: { notIn: hidden } }] } : {};
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      organization: await prisma.organization.findUnique({ where: { id: ctx.orgId } }),
      // Unfiltered on purpose: this is a whole-org archive, so it carries people who
      // have since been removed as well as current members. `removedAt` tells them
      // apart — dropping them would make the export disagree with the history it is
      // exported alongside.
      members: await prismaUnfiltered.orgMember.findMany({ where: { orgId: ctx.orgId }, include: { user: true } }),
      projects: await prisma.project.findMany({ where: { orgId: ctx.orgId, ...(hidden.length ? { id: { notIn: hidden } } : {}) } }),
      workItems: await prisma.workItem.findMany({ where: { orgId: ctx.orgId, ...inVisible } }).catch(() => []),
      intervals: await prisma.interval.findMany({ where: { orgId: ctx.orgId, ...inVisible } }).catch(() => []),
      crmContacts: await prisma.crmContact.findMany({ where: { orgId: ctx.orgId } }).catch(() => []),
      partners: await prisma.partner.findMany({ where: { orgId: ctx.orgId } }).catch(() => []),
      products: await prisma.product.findMany({ where: { orgId: ctx.orgId } }).catch(() => []),
      contracts: await prisma.contract.findMany({ where: { orgId: ctx.orgId, ...noneOrVisible } }).catch(() => []),
      notes: await prisma.note.findMany({ where: { orgId: ctx.orgId } }).catch(() => []),
      meetings: await prisma.syncMeeting.findMany({ where: { orgId: ctx.orgId, ...noneOrVisible } }).catch(() => []),
      timeEntries: await prisma.timeEntry
        .findMany({ where: { orgId: ctx.orgId, ...NOT_VOIDED, ...noneOrVisible } })
        .catch(() => []),
      revenues: await prisma.revenue.findMany({ where: { orgId: ctx.orgId } }).catch(() => []),
      expenses: await prisma.expense.findMany({ where: { orgId: ctx.orgId, ...noneOrVisible } }).catch(() => []),
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
