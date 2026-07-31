import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import {
  submitTransition,
  approveTransition,
  rejectTransition,
  approvalAuthority,
} from "@/lib/time/approval";
import {
  applyTimesheetTransition,
  isManagerOf,
  hasManager,
} from "@/lib/time/timesheet-actions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; timesheetId: string }> };

const actionSchema = z.object({
  action: z.enum(["submit", "approve", "reject"]),
  lane: z.enum(["labor", "cost"]).optional(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * Submit / approve / reject a timesheet — the period-level workflow.
 *
 * ONE route for all three deliberately. Split across three files, the authority
 * check gets copied three times and drifts; here "who may act on this sheet" is
 * answered once, before the action is even read.
 *
 * The cost lane is disabled for now (`requireCostApproval: false`), so labor
 * approval completes a timesheet. The state machine models both lanes already,
 * so enabling it per-org is a policy row rather than a rewrite.
 */
const LANE_CONFIG = { requireCostApproval: false };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, timesheetId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TIME_READ);

    const sheet = await prisma.timesheet.findFirst({
      where: { id: timesheetId, orgId },
    });
    if (!sheet) return new Response("Not found", { status: 404 });

    const body = actionSchema.parse(await request.json());
    const isOwner = sheet.userId === ctx.userId;

    // ── Submit: the worker's own action, and only theirs ────────────────────
    if (body.action === "submit") {
      if (!isOwner) {
        return bad(
          "You can only submit your own timesheet",
          403,
        );
      }
      const t = submitTransition(sheet.status);
      if (!t.ok) return bad(t.reason, 409);

      const updated = await applyTimesheetTransition({
        orgId,
        timesheetId,
        next: t.next,
        actorId: ctx.userId,
      });
      await audit(request, ctx.userId, orgId, timesheetId, "timesheet.submitted");
      return success(updated);
    }

    // ── Approve / reject: authority first, action second ────────────────────
    const authority = approvalAuthority({
      actorUserId: ctx.userId,
      subjectUserId: sheet.userId,
      hasTimeApprove: hasPermission(ctx.permissions, Permission.TIME_APPROVE),
      isManagerOfSubject: await isManagerOf(orgId, ctx.userId, sheet.userId),
      subjectHasManager: await hasManager(orgId, sheet.userId),
    });
    if (!authority.allowed) {
      return bad(authority.reason ?? "You cannot approve this timesheet", 403);
    }

    if (body.action === "reject") {
      const t = rejectTransition(sheet.status);
      if (!t.ok) return bad(t.reason, 409);
      if (!body.reason) {
        // A rejection the worker cannot act on is a dead end: they are told the
        // week came back but not what to change.
        return bad("A reason is required when rejecting a timesheet", 400);
      }
      const updated = await applyTimesheetTransition({
        orgId,
        timesheetId,
        next: t.next,
        actorId: ctx.userId,
        rejectedReason: body.reason,
      });
      await audit(request, ctx.userId, orgId, timesheetId, "timesheet.rejected");
      return success(updated);
    }

    const lane = body.lane ?? "labor";
    const t = approveTransition(sheet.status, lane, LANE_CONFIG);
    if (!t.ok) return bad(t.reason, 409);

    const updated = await applyTimesheetTransition({
      orgId,
      timesheetId,
      next: t.next,
      actorId: ctx.userId,
      lane,
    });
    await audit(request, ctx.userId, orgId, timesheetId, "timesheet.approved");
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

function audit(
  request: NextRequest,
  userId: string,
  orgId: string,
  timesheetId: string,
  action: string,
) {
  return logAudit({
    orgId,
    userId,
    action,
    entity: "timesheet",
    entityId: timesheetId,
    ipAddress: getIpAddress(request),
  });
}
