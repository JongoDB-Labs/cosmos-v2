import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { runFeedbackRemediation } from "@/lib/feedback/remediate";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * Trigger a run of the auto-remediation loop (FR 695aa097): deliver this org's
 * OPEN, not-yet-delivered feedback into the work backlog. Idempotent and
 * opt-in — a no-op unless the org enabled it with a target project.
 *
 * Auth via `resolveAuth`, so a scheduled GitHub Action can call it with an
 * org API key (`Bearer cosmos_…`, scope `items:write`) or a signed-in admin can
 * kick it from the UI. Gated on ITEM_CREATE — the only mutation the loop makes
 * is creating work items (feedback status is updated server-side by the worker).
 *
 * Body (optional): `{ "limit": number }` — cap items processed this run
 * (default 10, max 50).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await resolveAuth(request, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    if (!hasPermission(ctx.permissions, Permission.ITEM_CREATE)) {
      return new Response("Forbidden", { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as { limit?: number };
    const summary = await runFeedbackRemediation(orgId, {
      actorUserId: ctx.userId,
      limit: typeof body.limit === "number" ? body.limit : undefined,
    });

    return success(summary);
  } catch (error) {
    return handleApiError(error);
  }
}
