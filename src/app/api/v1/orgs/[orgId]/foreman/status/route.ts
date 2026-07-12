import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { assembleStatus } from "@/lib/foreman/status-read";

type RouteParams = { params: Promise<{ orgId: string }> };

/** Foreman console pulse — owner/admin surface (same gate as the automation config). */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { slug: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_UPDATE);

    // Viewing the console is the ORG_UPDATE surface, but STEERING the deployer
    // (Approve / Rebuild) is a BASE OWNER/ADMIN privilege — matching the daemon's
    // own privilegedUserIds gate, so a work-role-widened MEMBER (ORG_UPDATE but
    // base role MEMBER) sees the cards read-only and can't push a lever the daemon
    // would ignore.
    const actorCanSteer = ctx.orgRole === OrgRole.OWNER || ctx.orgRole === OrgRole.ADMIN;

    return success(await assembleStatus(orgId, actorCanSteer));
  } catch (e) {
    return handleApiError(e);
  }
}
