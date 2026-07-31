import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireAccess } from "@/lib/abac/require-access";
import { Permission } from "@/lib/rbac/permissions";
import { redactRates } from "@/lib/time/visibility";
import { readableTimeUserIds, timeUserIdFilter } from "@/lib/time/scope";
import { timesheetIdForEntry, isTimesheetOpen } from "@/lib/time/timesheet";
import { recordRevision } from "@/lib/time/revisions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { BillableType } from "@prisma/client";

const updateTimeEntrySchema = z.object({
  date: z.string().nullish(),
  hours: z.number().positive().optional(),
  rate: z.number().optional(),
  client: z.string().nullish(),
  projectId: z.string().uuid().nullish(),
  workItemId: z.string().uuid().nullish(),
  clinId: z.string().uuid().nullish(),
  description: z.string().nullish(),
  billableType: z.nativeEnum(BillableType).optional(),
  tags: z.array(z.string()).optional(),
});

type RouteParams = { params: Promise<{ orgId: string; entryId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, entryId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TIME_READ);

    const entry = await prisma.timeEntry.findFirst({
      where: {
        id: entryId,
        orgId,
        // Same scoping rule as the list route: TIME_READ_ALL sees everything,
        // otherwise it is the actor plus their direct reports. Folded into the
        // query rather than checked after, so "not yours" and "does not exist"
        // are the SAME 404 — a 403 here would confirm an entry exists, which is
        // itself information an actor without access should not obtain.
        userId: timeUserIdFilter(await readableTimeUserIds(ctx)),
        // A voided entry reads as gone, same 404 as one that never existed.
        voidedAt: null,
      },
    });

    if (!entry) return new Response("Not found", { status: 404 });

    return success(redactRates(ctx, [entry])[0]);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, entryId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.timeEntry.findFirst({
      where: { id: entryId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz: TIME_UPDATE bitfield check + any narrowing deny
    // policy. TimeEntry ownership is userId. Identical to requirePermission
    // until a policy exists.
    await requireAccess(ctx, "TIME_UPDATE", { ownerId: existing.userId });

    const isAdminOrOwner = ctx.orgRole === "ADMIN" || ctx.orgRole === "OWNER";
    if (!isAdminOrOwner) {
      if (existing.userId !== ctx.userId) {
        return new Response(
          JSON.stringify({ error: "You can only update your own time entries" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      if (existing.status !== "DRAFT") {
        return new Response(
          JSON.stringify({ error: "Only draft entries can be updated" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const body = await request.json();
    const data = updateTimeEntrySchema.parse(body);

    // Once a period is submitted or approved, its hours must not move — that is
    // the whole point of approving them. Checked even for admins: an approved
    // period changing silently is exactly what an audit trail exists to catch.
    if (!(await isTimesheetOpen(existing.timesheetId))) {
      return new Response(
        JSON.stringify({ error: "This timesheet has been submitted and can no longer be edited" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }

    // Moving an entry's date can move it to a DIFFERENT pay period, which
    // reparents it. Refuse if the destination period is already settled,
    // otherwise hours could be walked into a closed period after the fact.
    let timesheetId = existing.timesheetId;
    if (data.date) {
      const destination = await timesheetIdForEntry(orgId, existing.userId, data.date);
      if (destination !== existing.timesheetId && !(await isTimesheetOpen(destination))) {
        return new Response(
          JSON.stringify({ error: "That date falls in a timesheet that has already been submitted" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      timesheetId = destination;
    }

    const updated = await prisma.timeEntry.update({
      where: { id: entryId },
      data: {
        timesheetId,
        ...(data.date !== undefined && data.date !== null && { date: new Date(data.date) }),
        ...(data.hours !== undefined && { hours: data.hours }),
        ...(data.rate !== undefined && { rate: data.rate }),
        ...(data.client !== undefined && { client: data.client }),
        ...(data.projectId !== undefined && { projectId: data.projectId }),
        ...(data.workItemId !== undefined && { workItemId: data.workItemId }),
        ...(data.clinId !== undefined && { clinId: data.clinId }),
        ...(data.description !== undefined && { description: data.description ?? "" }),
        ...(data.billableType !== undefined && { billableType: data.billableType }),
        ...(data.tags !== undefined && { tags: data.tags }),
      },
    });

    // Values, not just field names: "hours changed" cannot answer "changed from
    // what?". Written AFTER the update so a failed write leaves no history of a
    // change that did not happen.
    await recordRevision({
      orgId,
      timeEntryId: entryId,
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
      actorId: ctx.userId,
      actorIp: getIpAddress(request),
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "time_entry.updated",
      entity: "time_entry",
      entityId: entryId,
      metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, entryId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.timeEntry.findFirst({
      // An already-voided entry is gone as far as callers are concerned, so
      // voiding it again is a 404 rather than a second void record.
      where: { id: entryId, orgId, voidedAt: null },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz: TIME_DELETE bitfield check + any narrowing deny
    // policy. TimeEntry ownership is userId. Identical to requirePermission
    // until a policy exists.
    await requireAccess(ctx, "TIME_DELETE", { ownerId: existing.userId });

    if (existing.status !== "DRAFT") {
      return new Response(
        JSON.stringify({ error: "Only draft entries can be deleted" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const isAdminOrOwner = ctx.orgRole === "ADMIN" || ctx.orgRole === "OWNER";
    if (existing.userId !== ctx.userId && !isAdminOrOwner) {
      return new Response(
        JSON.stringify({ error: "You can only delete your own time entries" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // VOID, not DELETE. The row and its hours are retained; every read filters
    // `voidedAt: null`, so the caller sees exactly what a delete looked like.
    // Hard deletion would make the dataset inadmissible — an auditor cannot
    // distinguish "never entered" from "removed after the fact" — and this is
    // the record a timesheet exists to produce.
    // An optional { reason } body. The current client sends no body at all on
    // DELETE, so parsing must never throw — a missing reason is allowed here
    // and becomes mandatory only under a strict timekeeping policy.
    let reason: string | null = null;
    try {
      const parsed = (await request.json()) as { reason?: unknown };
      if (typeof parsed?.reason === "string" && parsed.reason.trim()) {
        reason = parsed.reason.trim();
      }
    } catch {
      /* no body, or not JSON — reason stays null */
    }

    const voided = await prisma.timeEntry.update({
      where: { id: entryId },
      data: { voidedAt: new Date(), voidedById: ctx.userId, voidReason: reason },
    });

    await recordRevision({
      orgId,
      timeEntryId: entryId,
      before: existing as unknown as Record<string, unknown>,
      after: voided as unknown as Record<string, unknown>,
      actorId: ctx.userId,
      actorIp: getIpAddress(request),
      reason,
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "time_entry.voided",
      entity: "time_entry",
      entityId: entryId,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
