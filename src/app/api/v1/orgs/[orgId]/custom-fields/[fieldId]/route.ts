import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

const updateFieldSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  options: z.array(z.unknown()).optional(),
  required: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; fieldId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, fieldId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const field = await prisma.customField.findFirst({
      where: { id: fieldId, orgId },
    });
    if (!field) return new Response("Not found", { status: 404 });

    return success(field);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, fieldId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CUSTOM_FIELD_MANAGE);

    const field = await prisma.customField.findFirst({
      where: { id: fieldId, orgId },
    });
    if (!field) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateFieldSchema.parse(body);

    const updated = await prisma.customField.update({
      where: { id: fieldId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.options !== undefined
          ? { options: data.options as Prisma.InputJsonValue }
          : {}),
        ...(data.required !== undefined ? { required: data.required } : {}),
        ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "custom_field.updated",
      entity: "custom_field",
      entityId: fieldId,
      metadata: { name: updated.name, key: updated.key } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, fieldId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CUSTOM_FIELD_MANAGE);

    const field = await prisma.customField.findFirst({
      where: { id: fieldId, orgId },
    });
    if (!field) return new Response("Not found", { status: 404 });

    await prisma.customField.delete({ where: { id: fieldId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "custom_field.deleted",
      entity: "custom_field",
      entityId: fieldId,
      metadata: { name: field.name, key: field.key } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
