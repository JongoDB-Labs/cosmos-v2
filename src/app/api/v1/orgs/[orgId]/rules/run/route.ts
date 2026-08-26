import { NextRequest } from "next/server";
import { resolveAuth } from "@/lib/auth/api-key";
import { success, handleApiError } from "@/lib/api-helpers";
import { prisma } from "@/lib/db/client";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { runOrgRules } from "@/lib/rules/run";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * Evaluate every enabled plugin's standing rules for this org: raise flags for
 * what is wrong now, clear the ones whose condition has passed.
 *
 * Built to be called on a timer with an org API key, and safe to call at any
 * time -- rules are idempotent, and raising is idempotent in the DATABASE (the
 * partial unique index on open flags), not merely by convention, so two runs
 * overlapping cannot produce duplicate flags.
 *
 * Gated on RULES_RUN: the run has side effects (flags, notifications), so it
 * is an administrative action rather than a read -- but NOT on PLUGIN_MANAGE,
 * which also enables and reconfigures plugins. A key that sits on a cron box
 * should be able to do this and nothing else.
 *
 * Returns 200 with per-plugin detail even when a plugin failed, and 207 when
 * some did: the body is the useful part, and a scheduler needs to distinguish
 * "nothing to do" from "the finance rules have been broken since March".
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await resolveAuth(request, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    if (!hasPermission(ctx.permissions, Permission.RULES_RUN)) {
      return new Response("Forbidden", { status: 403 });
    }

    const result = await runOrgRules(orgId);
    return success(result, result.ok ? 200 : 207);
  } catch (error) {
    return handleApiError(error);
  }
}
