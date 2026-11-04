import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { readableTimePeople } from "@/lib/time/scope";
import { handleApiError } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { orgContext } from "@/lib/openapi/org-context";
import { canManageAllowances, timeOffBalance, timeOffPolicy } from "@/lib/time/time-off-balance";
import { getTimeOffSummary } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string }> };

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Everyone's time-off balance for a year — as far as the caller may see.
 *
 * WHO is `readableTimePeople`, the one definition of "whose time may I read"
 * in the time domain: a member gets their own row and nothing else, a
 * supervisor adds their reports, and only a TIME_READ_ALL holder sees the whole
 * org. The roster is decided before anything is fetched, so another person's
 * leave never reaches a query this caller couldn't have made.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx, org } = await orgContext((await params).orgId, getTimeOffSummary);
    const { query } = await parseRequest(getTimeOffSummary, request, params);
    requirePermission(ctx, Permission.TIME_READ);

    const now = new Date();
    const year = query.year ?? now.getUTCFullYear();
    const policy = timeOffPolicy(org.settings);
    const people = await readableTimePeople(ctx);
    const ids = people.map((p) => p.userId);

    const [requests, allowances] = await Promise.all([
      prisma.timeOffRequest.findMany({
        where: {
          orgId: org.id,
          userId: { in: ids },
          status: { in: ["PENDING", "APPROVED"] },
          kind: { in: policy.countedKinds },
          // Overlapping the year, so a request across New Year counts in both.
          startDate: { lte: new Date(`${year}-12-31T00:00:00.000Z`) },
          endDate: { gte: new Date(`${year}-01-01T00:00:00.000Z`) },
        },
        select: { userId: true, kind: true, status: true, startDate: true, endDate: true, hoursPerDay: true },
      }),
      prisma.timeOffAllowance.findMany({
        where: { orgId: org.id, year, userId: { in: ids } },
        select: { userId: true, hours: true },
      }),
    ]);

    const own = new Map(allowances.map((a) => [a.userId, Number(a.hours)]));
    const byUser = new Map<string, typeof requests>();
    for (const r of requests) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
    const today = iso(now);

    const rows = people.map((p) => {
      const personal = own.get(p.userId);
      const allowance = personal ?? policy.annualAllowanceHours;
      const balance = timeOffBalance(
        (byUser.get(p.userId) ?? []).map((r) => ({
          kind: r.kind,
          status: r.status,
          startDate: iso(r.startDate),
          endDate: iso(r.endDate),
          hoursPerDay: Number(r.hoursPerDay),
        })),
        { year, today, countedKinds: policy.countedKinds, allowance },
      );
      return {
        userId: p.userId,
        displayName: p.displayName,
        isSelf: p.isSelf,
        ...balance,
        allowanceSource: personal !== undefined ? ("person" as const) : allowance !== null ? ("org" as const) : null,
      };
    });

    return respond(getTimeOffSummary, 200, {
      year,
      countedKinds: policy.countedKinds,
      defaultAllowance: policy.annualAllowanceHours,
      canManage: canManageAllowances(ctx.permissions),
      rows,
    });
  } catch (error) {
    return handleApiError(error, request);
  }
}

