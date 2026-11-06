import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { denyAccountRequest as deny, NotPending } from "@/lib/auth/account-requests";

type RouteParams = { params: Promise<{ orgId: string; requestId: string }> };

/** Deny a pending request. The row is retained so the decision is attributable. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, requestId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { slug: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_MEMBERS);

    await deny({ orgId, requestId, actorUserId: ctx.userId, ipAddress: getIpAddress(request) });
    return success({ ok: true });
  } catch (error) {
    if (error instanceof NotPending) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    return handleApiError(error);
  }
}
