import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const patchWorkItemTypeSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  pluralName: z.string().max(100).nullable().optional(),
  icon: z.string().max(100).nullable().optional(),
  color: z.string().max(20).nullable().optional(),
  defaultParentTypeKey: z.string().max(50).nullable().optional(),
  celebrateOnComplete: z.boolean().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; typeId: string }> };

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, typeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_TEMPLATES);

    const workItemType = await prisma.workItemType.findUnique({ where: { id: typeId } });
    if (!workItemType) return new Response("Not found", { status: 404 });
    if (workItemType.orgId !== orgId) return new Response("Not found", { status: 404 });

    if (workItemType.isBuiltIn) {
      return new Response(
        JSON.stringify({ error: "Cannot modify built-in work item types" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await request.json();
    const data = patchWorkItemTypeSchema.parse(body);

    const updated = await prisma.workItemType.update({
      where: { id: typeId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.pluralName !== undefined ? { pluralName: data.pluralName } : {}),
        ...(data.icon !== undefined ? { icon: data.icon } : {}),
        ...(data.color !== undefined ? { color: data.color } : {}),
        ...(data.defaultParentTypeKey !== undefined ? { defaultParentTypeKey: data.defaultParentTypeKey } : {}),
        ...(data.celebrateOnComplete !== undefined ? { celebrateOnComplete: data.celebrateOnComplete } : {}),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "work_item_type.updated",
      entity: "work_item_type",
      entityId: typeId,
      metadata: { name: updated.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, typeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_TEMPLATES);

    const workItemType = await prisma.workItemType.findUnique({ where: { id: typeId } });
    if (!workItemType) return new Response("Not found", { status: 404 });
    if (workItemType.orgId !== orgId) return new Response("Not found", { status: 404 });

    if (workItemType.isBuiltIn) {
      return new Response(
        JSON.stringify({ error: "Cannot delete built-in work item types" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const inUseCount = await prisma.workItem.count({ where: { workItemTypeId: typeId } });
    if (inUseCount > 0) {
      return new Response(
        JSON.stringify({ error: "Work item type is in use by existing work items", count: inUseCount }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    await prisma.workItemType.delete({ where: { id: typeId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "work_item_type.deleted",
      entity: "work_item_type",
      entityId: typeId,
      metadata: { key: workItemType.key, name: workItemType.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
