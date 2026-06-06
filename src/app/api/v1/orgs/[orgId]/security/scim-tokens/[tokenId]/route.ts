import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const updateTokenSchema = z.object({
  label: z.string().max(200),
});

type RouteParams = { params: Promise<{ orgId: string; tokenId: string }> };

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, tokenId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SCIM_MANAGE);

    const existing = await prisma.scimToken.findFirst({
      where: { id: tokenId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateTokenSchema.parse(body);

    const updated = await prisma.scimToken.update({
      where: { id: tokenId },
      data: { label: data.label },
      select: {
        id: true,
        prefix: true,
        label: true,
        expiresAt: true,
        lastUsed: true,
        createdAt: true,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "scim_token.updated",
      entity: "scim_token",
      entityId: tokenId,
      metadata: { label: data.label } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, tokenId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SCIM_MANAGE);

    const existing = await prisma.scimToken.findFirst({
      where: { id: tokenId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.scimToken.delete({ where: { id: tokenId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "scim_token.deleted",
      entity: "scim_token",
      entityId: tokenId,
      metadata: { prefix: existing.prefix } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
