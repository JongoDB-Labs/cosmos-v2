import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { IntegrationRegistry } from "@/lib/integrations/registry";
import "@/lib/integrations/registry/index";
import { splitConfigSecrets } from "@/lib/integrations/config-secrets";
import { setOrgCredential, deleteOrgCredential } from "@/lib/integrations/credentials";

const updateIntegrationSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "ERROR"]).optional(),
});

type RouteParams = { params: Promise<{ orgId: string; integrationId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, integrationId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.INTEGRATION_MANAGE);

    const integration = await prisma.integration.findFirst({
      where: { id: integrationId, orgId },
    });

    if (!integration) return new Response("Not found", { status: 404 });

    return success(integration);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, integrationId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.INTEGRATION_MANAGE);

    const existing = await prisma.integration.findFirst({
      where: { id: integrationId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateIntegrationSchema.parse(body);

    // When config is being updated, split out secret fields: seal any newly-supplied
    // secret value into the org-level vault credential (a blank secret field means
    // "leave the existing sealed secret untouched"), and persist only the non-secret
    // fields to plaintext Integration.config — never the secret.
    let configUpdate: Record<string, unknown> | undefined;
    if (data.config !== undefined) {
      const provider = IntegrationRegistry.get(existing.provider);
      const { publicConfig, secrets, hasSecrets } = splitConfigSecrets(provider, data.config);
      if (hasSecrets) {
        await setOrgCredential(orgId, existing.provider, secrets);
      }
      configUpdate = publicConfig;
    }

    const updated = await prisma.integration.update({
      where: { id: integrationId },
      data: {
        ...(data.displayName !== undefined ? { displayName: data.displayName } : {}),
        ...(configUpdate !== undefined
          ? { config: configUpdate as Prisma.InputJsonValue }
          : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "integration.updated",
      entity: "integration",
      entityId: integrationId,
      metadata: { provider: updated.provider } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, integrationId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.INTEGRATION_MANAGE);

    const integration = await prisma.integration.findFirst({
      where: { id: integrationId, orgId },
    });
    if (!integration) return new Response("Not found", { status: 404 });

    await prisma.integration.delete({ where: { id: integrationId } });

    // Tear down the sealed org-level credential so the secret doesn't outlive the
    // integration (idempotent — a no-op if the provider had no sealed secret).
    await deleteOrgCredential(orgId, integration.provider);

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "integration.uninstalled",
      entity: "integration",
      entityId: integrationId,
      metadata: { provider: integration.provider } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
