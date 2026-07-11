import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string }> };

const OPEN_STATUSES = ["OPEN", "PLANNED", "IN_PROGRESS", "IN_REVIEW"] as const;
const CLOSED_STATUSES = ["DONE", "DECLINED"] as const;

/**
 * Bug/feature-request analytics for the org: counts by type × status, open vs
 * resolved totals, a 30-day opened/resolved trend, and the top recent items —
 * so admins have visibility into what's been reported and what's been fixed.
 * Read-only aggregation over FeedbackItem (no new schema). ANALYTICS_READ gated.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ANALYTICS_READ);

    const grouped = await prisma.feedbackItem.groupBy({
      by: ["type", "status"],
      where: { orgId },
      _count: { _all: true },
    });

    // counts[type][status] = n
    const counts: Record<string, Record<string, number>> = {
      BUG: {},
      FEATURE: {},
    };
    let total = 0;
    for (const g of grouped) {
      const n = g._count._all;
      counts[g.type] = counts[g.type] ?? {};
      counts[g.type][g.status] = n;
      total += n;
    }

    const sumFor = (type: string, statuses: readonly string[]) =>
      statuses.reduce((acc, s) => acc + (counts[type]?.[s] ?? 0), 0);

    const totals = {
      total,
      bugs: Object.values(counts.BUG ?? {}).reduce((a, b) => a + b, 0),
      features: Object.values(counts.FEATURE ?? {}).reduce((a, b) => a + b, 0),
      open: sumFor("BUG", OPEN_STATUSES) + sumFor("FEATURE", OPEN_STATUSES),
      resolved: sumFor("BUG", CLOSED_STATUSES) + sumFor("FEATURE", CLOSED_STATUSES),
      openBugs: sumFor("BUG", OPEN_STATUSES),
      openFeatures: sumFor("FEATURE", OPEN_STATUSES),
    };

    // 30-day opened/resolved trend (by day). updatedAt approximates the
    // resolution moment for items currently in a closed status.
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const recentForTrend = await prisma.feedbackItem.findMany({
      where: { orgId, OR: [{ createdAt: { gte: since } }, { updatedAt: { gte: since } }] },
      select: { createdAt: true, updatedAt: true, status: true },
    });
    const trendMap = new Map<string, { opened: number; resolved: number }>();
    const dayKey = (d: Date) => d.toISOString().slice(0, 10);
    for (const f of recentForTrend) {
      if (f.createdAt >= since) {
        const k = dayKey(f.createdAt);
        const e = trendMap.get(k) ?? { opened: 0, resolved: 0 };
        e.opened += 1;
        trendMap.set(k, e);
      }
      if (
        (CLOSED_STATUSES as readonly string[]).includes(f.status) &&
        f.updatedAt >= since
      ) {
        const k = dayKey(f.updatedAt);
        const e = trendMap.get(k) ?? { opened: 0, resolved: 0 };
        e.resolved += 1;
        trendMap.set(k, e);
      }
    }
    const trend = [...trendMap.entries()]
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Top recent items (most-voted first, then newest), with author names.
    const recent = await prisma.feedbackItem.findMany({
      where: { orgId },
      orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
      take: 50,
      select: {
        id: true,
        type: true,
        status: true,
        title: true,
        voteCount: true,
        createdAt: true,
        updatedAt: true,
        authorId: true,
        telemetry: true,
      },
    });
    const authorIds = [...new Set(recent.map((r) => r.authorId))];
    const authors = authorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: authorIds } },
          select: { id: true, displayName: true },
        })
      : [];
    const nameById = new Map(authors.map((u) => [u.id, u.displayName]));

    return success({
      counts,
      totals,
      trend,
      recent: recent.map((r) => {
        // Surface compact triage telemetry for auto-reported bugs (hit count +
        // which build it last hit) — populated by /feedback/report-bug.
        const tel = (r.telemetry ?? {}) as {
          hits?: number;
          appVersion?: string | null;
        };
        const telemetry =
          typeof tel.hits === "number"
            ? { hits: tel.hits, appVersion: tel.appVersion ?? null }
            : null;
        return {
          id: r.id,
          type: r.type,
          status: r.status,
          title: r.title,
          voteCount: r.voteCount,
          createdAt: r.createdAt.toISOString(),
          authorName: nameById.get(r.authorId) ?? null,
          telemetry,
        };
      }),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
