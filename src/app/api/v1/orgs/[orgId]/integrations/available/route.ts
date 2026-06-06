import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { IntegrationRegistry } from "@/lib/integrations/registry";
import "@/lib/integrations/registry/index";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.INTEGRATION_MANAGE);

    const installed = await prisma.integration.findMany({
      where: { orgId },
      select: { provider: true },
    });

    const installedSlugs = new Set(installed.map((i) => i.provider));

    const providers = IntegrationRegistry.getAll().map((provider) => ({
      ...provider,
      installed: installedSlugs.has(provider.slug),
    }));

    return success(providers);
  } catch (error) {
    return handleApiError(error);
  }
}
