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

    const data = await prisma.timesheet.findMany({
      where,
      orderBy: { periodStart: "desc" },
      take: 200,
    });

    return success({ data, total: data.length });
  } catch (error) {
    return handleApiError(error);
  }
}
