import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const updateEntrySchema = z.object({
  label: z.string().max(200),
});

type RouteParams = { params: Promise<{ orgId: string; entryId: string }> };

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, entryId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SECURITY_MANAGE);

    const existing = await prisma.ipAllowlist.findFirst({
      where: { id: entryId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateEntrySchema.parse(body);

    const updated = await prisma.ipAllowlist.update({
      where: { id: entryId },
      data: { label: data.label },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "ip_allowlist.updated",
      entity: "ip_allowlist",
      entityId: entryId,
      metadata: { cidr: existing.cidr, label: data.label } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, entryId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SECURITY_MANAGE);

    const existing = await prisma.ipAllowlist.findFirst({
      where: { id: entryId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.ipAllowlist.delete({ where: { id: entryId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "ip_allowlist.deleted",
      entity: "ip_allowlist",
      entityId: entryId,
      metadata: { cidr: existing.cidr } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
