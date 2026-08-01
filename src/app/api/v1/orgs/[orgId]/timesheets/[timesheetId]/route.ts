import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import {
  submitTransition,
  withdrawTransition,
  approveTransition,
  rejectTransition,
  approvalAuthority,
} from "@/lib/time/approval";
import {
  applyTimesheetTransition,
  isManagerOf,
  hasManager,
} from "@/lib/time/timesheet-actions";
import { resolveApprovalRoute } from "@/lib/time/routing";
import {
  notifyTimesheetSubmitted,
  notifyTimesheetDecision,
} from "@/lib/time/notify";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; timesheetId: string }> };

const actionSchema = z.object({
  action: z.enum(["submit", "withdraw", "approve", "reject"]),
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

      // Resolved BEFORE the write and stamped with it, so the sheet records who
      // it was handed to at the moment it was handed over. Deriving it later
      // would let an org-chart change rewrite the history of a closed period.
      const route = await resolveApprovalRoute(orgId, sheet.userId);

      const updated = await applyTimesheetTransition({
        orgId,
        timesheetId,
        next: t.next,
        actorId: ctx.userId,
        // The people actually asked — all of them. Stamping only a "primary"
        // approver would discard the rest, and the pool case has no primary.
        approverIds: route.notify,
      });
      await audit(request, ctx.userId, orgId, timesheetId, "timesheet.submitted");

      const [worker, approverNames] = await Promise.all([
        displayNameOf(sheet.userId),
        displayNamesOf(route.notify),
      ]);

      // After the write, and unable to fail it — see lib/time/notify.ts.
      await notifyTimesheetSubmitted({
        orgId,
        timesheetId,
        workerUserId: sheet.userId,
        workerName: worker,
        periodStart: sheet.periodStart,
        periodEnd: sheet.periodEnd,
        route,
      });

      // The worker asked "who am I submitting this to?" — answer it in the
      // response rather than making them guess from a status badge.
      return success({
        ...updated,
        routedTo: { reason: route.reason, approverNames },
      });
    }

    // ── Withdraw: also the worker's own action, and only theirs ─────────────
    if (body.action === "withdraw") {
      if (!isOwner) {
        return bad("You can only withdraw your own timesheet", 403);
      }
      const t = withdrawTransition(
        sheet.status,
        // Any signed lane blocks it, regardless of status.
        Boolean(sheet.laborApprovedById || sheet.costApprovedById),
      );
      if (!t.ok) return bad(t.reason, 409);

      const updated = await applyTimesheetTransition({
        orgId,
        timesheetId,
        next: t.next,
        actorId: ctx.userId,
      });
      await audit(request, ctx.userId, orgId, timesheetId, "timesheet.withdrawn");
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
      await notifyTimesheetDecision({
        orgId,
        timesheetId,
        workerUserId: sheet.userId,
        deciderName: await displayNameOf(ctx.userId),
        decision: "rejected",
        reason: body.reason,
        periodStart: sheet.periodStart,
        periodEnd: sheet.periodEnd,
      });
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

    // Only when the sheet is FULLY approved. Under a two-lane policy, telling a
    // worker their week is "approved" after the labor lane alone would be
    // wrong: the cost lane can still reject it.
    if (t.next === "APPROVED") {
      await notifyTimesheetDecision({
        orgId,
        timesheetId,
        workerUserId: sheet.userId,
        deciderName: await displayNameOf(ctx.userId),
        decision: "approved",
        periodStart: sheet.periodStart,
        periodEnd: sheet.periodEnd,
      });
    }
    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

/** Display name for a notification body. Never throws — a missing name must not
 *  fail an approval that has already been written. */
async function displayNameOf(userId: string): Promise<string> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true },
    });
    return user?.displayName?.trim() || "Someone";
  } catch {
    return "Someone";
  }
}

/** Names for the routed approvers, in one query. Same never-throws contract. */
async function displayNamesOf(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  try {
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { displayName: true },
    });
    return users.map((u) => u.displayName).filter(Boolean);
  } catch {
    return [];
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
