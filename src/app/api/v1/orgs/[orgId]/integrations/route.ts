import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { randomBytes } from "crypto";
import type { Prisma } from "@prisma/client";
import { IntegrationRegistry } from "@/lib/integrations/registry";
import "@/lib/integrations/registry/index";

const createIntegrationSchema = z.object({
  provider: z.string().min(1).max(100),
  displayName: z.string().min(1).max(200).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.INTEGRATION_MANAGE);

    const integrations = await prisma.integration.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
    });

    return success(integrations);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.INTEGRATION_MANAGE);

    const body = await request.json();
    const data = createIntegrationSchema.parse(body);

    const provider = IntegrationRegistry.get(data.provider);
    if (!provider || provider.status !== "available" || provider.connect !== "config") {
      return NextResponse.json(
        { error: "This integration isn't available to install yet." },
        { status: 400 },
      );
    }

    const integration = await prisma.integration.create({
      data: {
        orgId,
        provider: data.provider,
        displayName: data.displayName ?? data.provider,
        config: (data.config ?? {}) as Prisma.InputJsonValue,
        status: "ACTIVE",
        installedById: ctx.userId,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "integration.installed",
      entity: "integration",
      entityId: integration.id,
      metadata: { provider: data.provider } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(integration);
  } catch (error) {
    return handleApiError(error);
  }
}
