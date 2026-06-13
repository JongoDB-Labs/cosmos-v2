import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { proposeItems } from "@/lib/files/propose";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; docId: string }>;
};

/**
 * POST — AI-propose project items from a document (via the in-tenant LLM through
 * the CUI-aware egress chokepoint). Returns proposals only; no writes. The caller
 * reviews and accepts each (→ the convert route). Gated PROJECT_UPDATE (an active
 * model call). Fails with the egress error (e.g. "no model credential") if the org
 * has no model configured.
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, docId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const doc = await prisma.document.findFirst({
      where: { id: docId, orgId, projectId },
      select: { id: true },
    });
    if (!doc) return new Response("Not found", { status: 404 });

    const proposals = await proposeItems({ orgId, projectId, userId: ctx.userId, docId });
    return success({ proposals });
  } catch (e) {
    return handleApiError(e);
  }
}
