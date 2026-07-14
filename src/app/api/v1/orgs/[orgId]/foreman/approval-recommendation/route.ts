import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission, ForbiddenError } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { PARKED_EVENT_KINDS, pickParkEvent } from "@/lib/foreman/observe";
import { recommendForApproval } from "@/lib/foreman/approval-recommendation";

type RouteParams = { params: Promise<{ orgId: string }> };

const querySchema = z.object({ workItemId: z.string().uuid() });

/**
 * Per-item AI recommendation for a parked (review) work item in the Foreman
 * console's Awaiting-Approval section. Same gate as the rest of the steering
 * surface: the console is ORG_UPDATE-gated, but running the analysis (Foreman's
 * own subscription, a paid model call) is a BASE OWNER/ADMIN privilege — matching
 * the daemon's privilegedUserIds gate and the console's `actorCanSteer`, so a
 * work-role-widened MEMBER can't spend Foreman's tokens.
 *
 * The prUrl + park reason are derived SERVER-SIDE from the item's own park event
 * (never trusted from the client), and the result is cached per PR head SHA in
 * {@link recommendForApproval} so the 15s status poll doesn't recompute it.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { slug: true, tenantClass: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_UPDATE);
    if (ctx.orgRole !== OrgRole.OWNER && ctx.orgRole !== OrgRole.ADMIN) {
      throw new ForbiddenError("steering the delivery agent requires the Owner or Admin base role");
    }

    const { searchParams } = new URL(request.url);
    const { workItemId } = querySchema.parse({ workItemId: searchParams.get("workItemId") });

    // Scope to orgId so a foreign id can't leak existence cross-tenant.
    const item = await prisma.workItem.findFirst({
      where: { id: workItemId, orgId },
      select: { id: true },
    });
    if (!item) return new Response("Not found", { status: 404 });

    // Derive prUrl + reason from the item's own park event — the SAME
    // pickParkEvent selection the status payload uses, so the two never disagree.
    const events = await prisma.foremanEvent.findMany({
      where: { workItemId, kind: { in: [...PARKED_EVENT_KINDS] } },
      orderBy: [{ ts: "desc" }, { id: "desc" }],
    });
    const ev = pickParkEvent(events);
    const data = (ev?.data ?? {}) as { reason?: string; prUrl?: string };

    const result = await recommendForApproval({
      orgId,
      tenantClass: org.tenantClass === "GOV" ? "gov" : "commercial",
      workItemId,
      prUrl: data.prUrl ?? null,
      reason: data.reason ?? ev?.message ?? null,
    });

    return success(result);
  } catch (e) {
    return handleApiError(e);
  }
}
