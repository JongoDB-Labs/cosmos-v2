import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { noContent, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string; keyId: string }> };

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, keyId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.API_KEY_MANAGE);

    // Scope the delete to {id, orgId} so a key can never be revoked cross-org.
    await prisma.apiKey.deleteMany({ where: { id: keyId, orgId } });
    return noContent();
  } catch (e) {
    return handleApiError(e);
  }
}
