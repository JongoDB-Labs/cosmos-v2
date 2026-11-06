import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { AccountRequestStatus } from "@prisma/client";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * The account-request queue for this org.
 *
 * Gated on ORG_MANAGE_MEMBERS — the same permission that governs inviting
 * someone, because reading who has asked to join is the same class of
 * information as the member list itself.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_MEMBERS);

    const statusParam = request.nextUrl.searchParams.get("status");
    const status =
      statusParam && statusParam in AccountRequestStatus
        ? (statusParam as AccountRequestStatus)
        : AccountRequestStatus.PENDING;

    const rows = await prisma.accountRequest.findMany({
      where: { orgId, status },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        email: true,
        note: true,
        status: true,
        createdAt: true,
        decidedAt: true,
        invitationId: true,
        decidedBy: { select: { id: true, displayName: true } },
      },
    });

    return success(rows);
  } catch (error) {
    return handleApiError(error);
  }
}
