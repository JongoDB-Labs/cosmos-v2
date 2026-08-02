import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { readableTimeUserIds, timeUserIdFilter } from "@/lib/time/scope";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * Timesheets the caller may see, newest period first.
 *
 * Scoped through `readableTimeUserIds` — the SAME rule as the entries
 * themselves, so a timesheet can never expose a period for someone whose hours
 * are not readable. Reusing that helper rather than re-deriving the rule is
 * what keeps the two from drifting apart.
 *
 * Backs both the status shown on the time-tracking page and a supervisor's
 * view of which weeks are waiting on them.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TIME_READ);

    const sp = request.nextUrl.searchParams;
    const userId = sp.get("userId") || null;
    const status = sp.get("status");
    const periodStart = sp.get("periodStart");

    const allowed = await readableTimeUserIds(ctx);
    if (allowed && userId && !allowed.includes(userId)) {
      // Same contract as the entries route: naming someone outside your scope
      // is a denial, not a silently narrowed result.
      return new Response(JSON.stringify({ error: "Access denied by policy" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    const where: Record<string, unknown> = { orgId };
    where.userId = userId ?? timeUserIdFilter(allowed);
    if (status) where.status = status;
    if (periodStart) where.periodStart = new Date(`${periodStart}T00:00:00.000Z`);

    // ── The approver's queue: weeks waiting on ME ──────────────────────────
    //
    // Filters on the ROUTING STAMP, not on authority. `approverIds` records who
    // was ASKED at submit time, which is exactly what "waiting on me" means;
    // authority is a wider set (`approvalAuthority`) and using it would fill an
    // admin's queue with every open week in the org, most of which somebody else
    // was actually asked to handle.
    //
    // Backed by the GIN index on `approverIds`, so `has` is a containment probe
    // rather than a scan.
    //
    // The actor's OWN week can never appear: `routeFor` drops the subject from
    // both the supervisor list and the pool, so their id is never stamped on
    // their own sheet.
    if (sp.get("awaitingMe") === "1") {
      where.approverIds = { has: ctx.userId };
      // Only sheets that still owe a decision. An approved or returned week is
      // no longer waiting on anyone, and leaving it here would make the queue
      // permanently non-empty — the fastest way to teach someone to ignore it.
      where.status = { in: ["SUBMITTED", "LABOR_APPROVED"] };
    }

    const rows = await prisma.timesheet.findMany({
      where,
      orderBy: { periodStart: "desc" },
      take: 200,
    });

    // Names for the worker and the routed approver, resolved in ONE query.
    // Without them the UI can only say "Submitted", which is precisely the gap
    // the worker hit: a status with no answer to "waiting on whom?".
    const ids = [
      ...new Set(rows.flatMap((r) => [r.userId, ...r.approverIds])),
    ];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, displayName: true },
      });
      for (const u of users) names.set(u.id, u.displayName);
    }

    const data = rows.map((r) => ({
      ...r,
      workerName: names.get(r.userId) ?? null,
      // A name per routed approver, in the stored order. An id with no user row
      // (a deleted account) is dropped rather than rendered as a raw UUID.
      approverNames: r.approverIds
        .map((id) => names.get(id))
        .filter((n): n is string => Boolean(n)),
    }));

    return success({ data, total: data.length });
  } catch (error) {
    return handleApiError(error);
  }
}
