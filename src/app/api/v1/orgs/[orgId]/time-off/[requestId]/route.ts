import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { approvalAuthority } from "@/lib/time/approval";
import { isManagerOf, hasManager } from "@/lib/time/timesheet-actions";
import { success, handleApiError } from "@/lib/api-helpers";
import { totalHours } from "@/lib/time/time-off";

type RouteParams = { params: Promise<{ orgId: string; requestId: string }> };

const patchSchema = z.object({
  action: z.enum(["approve", "deny", "withdraw"]),
  decisionNote: z.string().max(2000).optional(),
});

const iso = (d: Date) => d.toISOString().slice(0, 10);

const SELECT = {
  id: true,
  userId: true,
  kind: true,
  status: true,
  startDate: true,
  endDate: true,
  hoursPerDay: true,
  note: true,
  decidedById: true,
  decidedAt: true,
  decisionNote: true,
  createdAt: true,
} as const;

/**
 * Decide a request, or take your own back.
 *
 * Authority is `approvalAuthority`, the SAME rule the timesheet uses, rather
 * than a second one written here — the question "may this person sign off that
 * person's time" has one answer in this product, and two copies of it would
 * drift. It also carries the rule that matters most: somebody who has a
 * supervisor cannot approve their own leave, and somebody who has none falls to
 * whoever holds TIME_APPROVE, so a request can never deadlock because the only
 * possible approver is the person asking.
 *
 * Only a PENDING request can move. Deciding one twice is a 409, not a silent
 * overwrite of who decided it and when.
 */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, requestId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TIME_READ);

    const body = patchSchema.parse(await req.json());

    const existing = await prisma.timeOffRequest.findFirst({
      where: { id: requestId, orgId },
      select: { id: true, userId: true, status: true },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    if (existing.status !== "PENDING") {
      return new Response(`This request is already ${existing.status.toLowerCase()}`, {
        status: 409,
      });
    }

    if (body.action === "withdraw") {
      // Taking back your own ask. Nobody else's, including an approver's —
      // withdrawing somebody else's request would look identical to denying it
      // while leaving no record that a decision was made.
      if (existing.userId !== ctx.userId) {
        return new Response("You can only withdraw your own request", { status: 403 });
      }
      const updated = await prisma.timeOffRequest.update({
        where: { id: requestId },
        data: { status: "WITHDRAWN" },
        select: SELECT,
      });
      return success(shape(updated));
    }

    const authority = approvalAuthority({
      actorUserId: ctx.userId,
      subjectUserId: existing.userId,
      hasTimeApprove: hasPermission(ctx.permissions, Permission.TIME_APPROVE),
      isManagerOfSubject: await isManagerOf(orgId, ctx.userId, existing.userId),
      subjectHasManager: await hasManager(orgId, existing.userId),
    });
    if (!authority.allowed) {
      return new Response(authority.reason ?? "You cannot decide this request", {
        status: 403,
      });
    }

    const updated = await prisma.timeOffRequest.update({
      where: { id: requestId },
      data: {
        status: body.action === "approve" ? "APPROVED" : "DENIED",
        decidedById: ctx.userId,
        decidedAt: new Date(),
        decisionNote: body.decisionNote ?? null,
      },
      select: SELECT,
    });
    return success(shape(updated));
  } catch (e) {
    return handleApiError(e);
  }
}

function shape(r: {
  id: string;
  userId: string;
  kind: string;
  status: string;
  startDate: Date;
  endDate: Date;
  hoursPerDay: { toString(): string };
  note: string | null;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
}) {
  const startDate = iso(r.startDate);
  const endDate = iso(r.endDate);
  const hoursPerDay = Number(r.hoursPerDay);
  return {
    id: r.id,
    userId: r.userId,
    kind: r.kind,
    status: r.status,
    startDate,
    endDate,
    hoursPerDay,
    hours: totalHours({ startDate, endDate, hoursPerDay }),
    note: r.note,
    decidedById: r.decidedById,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    createdAt: r.createdAt.toISOString(),
  };
}
