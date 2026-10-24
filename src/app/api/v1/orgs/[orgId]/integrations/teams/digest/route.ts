import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit/bucket";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { teamsNotify, teamsEventEnabled } from "@/lib/integrations/teams-notify";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * Compose and post the org's daily Teams digest (FR 8a162fe7) — a one-message
 * summary of the last 24h: items completed, items created, feedback delivered.
 * OFF by default (the dailyDigest toggle gates the actual post). Callable by a
 * scheduled workflow with an org API key (.github/workflows/teams-digest.yml)
 * or manually by an admin.
 *
 * It POSTS to the org's Teams channel, so it is a write: a session needs
 * INTEGRATION_MANAGE, a key needs RULES_RUN (the `rules:run` scheduler scope)
 * plus ITEM_READ (`read`) to count; a read-only key is refused. At most one post
 * per org per hour, and the counts cover only the projects the caller can read.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await resolveAuth(request, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // A key needs rules:run to post AND read to count: the counts cover only
    // what the caller can read, so a rules:run-only key would post zeros.
    if (ctx.isApiKey) {
      if (!hasPermission(ctx.permissions, Permission.RULES_RUN) || !hasPermission(ctx.permissions, Permission.ITEM_READ)) {
        return new Response("This API key needs the rules:run and read scopes to post the Teams digest", { status: 403 });
      }
    } else if (!hasPermission(ctx.permissions, Permission.INTEGRATION_MANAGE)) {
      return new Response("Posting the Teams digest needs the integration-manage permission", { status: 403 });
    }

    // Cheap short-circuit before running the counts.
    if (!(await teamsEventEnabled(orgId, "dailyDigest"))) {
      return success({ posted: false, skipped: "digest-disabled" });
    }

    // One post per org per hour, however many callers or retries.
    const limited = rateLimit(`org:${orgId}|teams.digest`, { capacity: 1, refillPerSecond: 1 / 3600 });
    if (!limited.allowed) {
      return Response.json(
        { error: "rate_limited", retryAfter: limited.retryAfter },
        { status: 429, headers: { "Retry-After": String(limited.retryAfter) } },
      );
    }

    // Counted over what the caller can read (a key's projectScope, team
    // scoping); feedback filed against no project is org-level and counts.
    const readable = await getReadableProjectIds(ctx);
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [completed, createdCount, feedbackDelivered] = await Promise.all([
      prisma.workItem.count({ where: { orgId, projectId: { in: readable }, completedAt: { gte: since } } }),
      prisma.workItem.count({ where: { orgId, projectId: { in: readable }, createdAt: { gte: since } } }),
      prisma.feedbackItem.count({
        where: { orgId, deliveredAt: { gte: since }, OR: [{ projectId: null }, { projectId: { in: readable } }] },
      }),
    ]);

    await teamsNotify(
      orgId,
      "dailyDigest",
      `\u{1F4CB} <b>Daily digest</b> — last 24h: ` +
        `✅ ${completed} completed · \u{1F195} ${createdCount} created` +
        (feedbackDelivered > 0 ? ` · \u{1F6E0} ${feedbackDelivered} feedback delivered` : ""),
    );

    return success({ posted: true, completed, created: createdCount, feedbackDelivered });
  } catch (error) {
    return handleApiError(error);
  }
}
