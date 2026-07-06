import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { testTeamsConnection, postTeamsChannelMessage } from "@/lib/integrations/teams";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * Verify the org's Microsoft Teams credentials (FR 8a162fe7). Mints a Graph
 * token to prove the sealed Entra app creds are valid; when `post: true` and a
 * default channel is configured, also posts a visible test message so the admin
 * sees it land. Gated on INTEGRATION_MANAGE (admin surface). The token/secret
 * are never returned.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.INTEGRATION_MANAGE);

    const body = (await request.json().catch(() => ({}))) as { post?: boolean };

    const auth = await testTeamsConnection(orgId);
    if (!auth.ok) return success({ ok: false, stage: "auth", error: auth.error });

    if (body.post) {
      const posted = await postTeamsChannelMessage(orgId, {
        html: "✅ <b>Cosmos</b> is connected to this Microsoft Teams channel.",
      });
      if (!posted.ok) return success({ ok: false, stage: "post", error: posted.error });
      return success({ ok: true, posted: true });
    }

    return success({ ok: true, posted: false });
  } catch (error) {
    return handleApiError(error);
  }
}
