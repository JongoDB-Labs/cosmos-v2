import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { submitTransition } from "@/lib/time/approval";
import { applyTimesheetTransition } from "@/lib/time/timesheet-actions";
import { NOT_VOIDED } from "@/lib/time/not-voided";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; entryId: string }> };

/**
 * DEPRECATED shape, current behaviour: submits the TIMESHEET this entry belongs
 * to, not the entry alone.
 *
 * Submission is a period-level act. Submitting entries individually produces
 * half-submitted weeks that no approver, payroll run or auditor can interpret,
 * and it left two sources of approval truth — `TimeEntry.status` and
 * `Timesheet.status` — free to disagree.
 *
 * The route is kept rather than removed because deleting an endpoint is a
 * breaking change for any caller outside this repo, and it now routes to the
 * same transition + propagation as `POST /timesheets/[id]`, so the two doors
 * cannot diverge. Prefer the timesheet route; this one exists for compatibility.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, entryId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    // A voided entry must not be submittable — that path silently undid a void.
    const existing = await prisma.timeEntry.findFirst({
      where: { id: entryId, orgId, ...NOT_VOIDED },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    await requireAccess(ctx, "TIME_UPDATE", { ownerId: existing.userId });

    if (existing.userId !== ctx.userId) {
      return bad("You can only submit your own time entries", 403);
    }
    if (!existing.timesheetId) {
      return bad("This entry is not attached to a pay period", 409);
    }

    const sheet = await prisma.timesheet.findFirst({
      where: { id: existing.timesheetId, orgId },
      select: { status: true },
    });
    if (!sheet) return new Response("Not found", { status: 404 });

    const t = submitTransition(sheet.status);
    if (!t.ok) return bad(t.reason, 409);

    await applyTimesheetTransition({
      orgId,
      timesheetId: existing.timesheetId,
      next: t.next,
      actorId: ctx.userId,
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "timesheet.submitted",
      entity: "timesheet",
      entityId: existing.timesheetId,
      ipAddress: getIpAddress(request),
    });

    // The entry's own status moved with the timesheet; return it fresh.
    const updated = await prisma.timeEntry.findUnique({ where: { id: entryId } });
    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

function bad(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
