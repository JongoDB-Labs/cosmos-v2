import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { teamsNotify, teamsEventEnabled } from "@/lib/integrations/teams-notify";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * Compose and post the org's daily Teams digest (FR 8a162fe7) — a one-message
 * summary of the last 24h: items completed, items created, feedback delivered.
 * OFF by default (the dailyDigest toggle gates the actual post). Callable by a
 * scheduled workflow with an org API key (see teams-digest.yml.template
 * pattern) or manually by an admin. Gated on ITEM_READ (it only reads).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await resolveAuth(request, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    if (!hasPermission(ctx.permissions, Permission.ITEM_READ)) {
      return new Response("Forbidden", { status: 403 });
    }

    // Cheap short-circuit before running the counts.
    if (!(await teamsEventEnabled(orgId, "dailyDigest"))) {
      return success({ posted: false, skipped: "digest-disabled" });
    }

    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [completed, createdCount, feedbackDelivered] = await Promise.all([
      prisma.workItem.count({ where: { orgId, completedAt: { gte: since } } }),
      prisma.workItem.count({ where: { orgId, createdAt: { gte: since } } }),
      prisma.feedbackItem.count({ where: { orgId, deliveredAt: { gte: since } } }),
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
