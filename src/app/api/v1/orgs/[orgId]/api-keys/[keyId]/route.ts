import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { KEY_MANAGEMENT_REFUSAL, keyManagementAccess } from "@/lib/auth/api-key-manage.server";
import { refuseApiKey } from "@/lib/auth/key-gate";
import { ProblemError } from "@/lib/openapi/problem";
import { Uuid } from "@/lib/openapi/schemas/common";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; keyId: string }> };

/**
 * Revoke a key. An administrator of keys (API_KEY_MANAGE) may revoke any key
 * in the org; anyone else only their own. Someone else's key gets the same
 * 404 as a key that doesn't exist, so the answer can't be used to learn which
 * key ids are real.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, keyId } = await params;
    if (!Uuid.safeParse(orgId).success) throw new ProblemError(400, "invalid_request", "orgId must be a UUID");
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
    if (!org) throw new ProblemError(404, "not_found", "Organization not found");
    const ctx = await getAuthContext(org.slug);
    if (!ctx) throw new ProblemError(401, "unauthorized");
    // A key, before anything is read (bitless-routes.table.ts).
    refuseApiKey(ctx, KEY_MANAGEMENT_REFUSAL);
    const { managesAll } = keyManagementAccess(ctx);

    const notFound = new ProblemError(404, "not_found", "API key not found");
    if (!Uuid.safeParse(keyId).success) throw notFound;

    // Scoped to {id, orgId} so a key can never be revoked cross-org, and to the
    // caller's own keys unless they administer every key.
    const where = { id: keyId, orgId, ...(managesAll ? {} : { createdById: ctx.userId }) };
    const key = await prisma.apiKey.findFirst({
      where,
      select: { id: true, name: true, prefix: true, scopes: true, projectIds: true, expiresAt: true, createdById: true },
    });
    if (!key) throw notFound;
    const { count } = await prisma.apiKey.deleteMany({ where });
    // Revoked by someone else between the read and the delete.
    if (count === 0) throw notFound;

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "api_key.revoked",
      entity: "api_key",
      entityId: key.id,
      metadata: {
        name: key.name,
        prefix: key.prefix,
        scopes: key.scopes,
        projectIds: key.projectIds,
        expiresAt: key.expiresAt?.toISOString() ?? null,
        createdById: key.createdById,
      },
      ipAddress: getIpAddress(request),
    });
    return noContent();
  } catch (e) {
    return handleApiError(e);
  }
}
