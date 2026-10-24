import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { isFeedbackStaff } from "@/lib/feedback/access";
import { commentMarkingPolicy } from "@/lib/feedback/comments.server";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * What the staff composer offers on this org's feedback threads: on a gov
 * tenant, the classification marking picker and the org ceiling it is weighed
 * against. `marking` is null for everyone else, and for anyone not on the team.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // ORG_READ for a session; a key's `read` scope deliberately lacks it (see
    // SCOPE_MASK in lib/auth/api-key.ts), so a key reads this with PROJECT_READ.
    requirePermission(ctx, ctx.isApiKey ? Permission.PROJECT_READ : Permission.ORG_READ);

    return success({ marking: isFeedbackStaff(ctx) ? await commentMarkingPolicy(orgId) : null });
  } catch (e) {
    return handleApiError(e);
  }
}
