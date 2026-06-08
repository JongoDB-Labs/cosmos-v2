import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { disconnectOrgClaude } from "@/lib/ai/claude-subscription";

/**
 * Disconnect the org's Claude subscription — nulls out the sealed OAuth tokens on
 * OrgAiSettings. Gated by ORG_MANAGE_SETTINGS.
 */

type RouteParams = { params: Promise<{ orgId: string }> };

export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, slug: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_SETTINGS);

    await disconnectOrgClaude(orgId, ctx.userId);
    return success({ success: true });
  } catch (error) {
    return handleApiError(error);
  }
}
