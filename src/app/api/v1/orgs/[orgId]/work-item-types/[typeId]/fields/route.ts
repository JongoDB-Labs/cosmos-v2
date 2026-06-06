import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const fieldBindingSchema = z.object({
  customFieldId: z.string().uuid(),
  required: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  action: z.enum(["bind", "unbind"]),
});

type RouteParams = { params: Promise<{ orgId: string; typeId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
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
        JSON.stringify({ error: "Cannot modify fields of built-in work item types" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await request.json();
    const data = fieldBindingSchema.parse(body);

    if (data.action === "bind") {
      // Verify the custom field belongs to this org
      const customField = await prisma.customField.findUnique({ where: { id: data.customFieldId } });
      if (!customField) return new Response("Custom field not found", { status: 404 });
      if (customField.orgId !== orgId) return new Response("Custom field not found", { status: 404 });

      const binding = await prisma.workItemTypeField.upsert({
        where: {
          workItemTypeId_customFieldId: {
            workItemTypeId: typeId,
            customFieldId: data.customFieldId,
          },
        },
        update: {
          ...(data.required !== undefined ? { required: data.required } : {}),
          ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
        },
        create: {
          workItemTypeId: typeId,
          customFieldId: data.customFieldId,
          required: data.required ?? false,
          sortOrder: data.sortOrder ?? 0,
        },
      });

      await logAudit({
        orgId,
        userId: ctx.userId,
        action: "work_item_type.field_bound",
        entity: "work_item_type",
        entityId: typeId,
        metadata: {
          customFieldId: data.customFieldId,
          workItemTypeName: workItemType.name,
        } as Record<string, string>,
        ipAddress: getIpAddress(request),
      });

      return success(binding);
    } else {
      // unbind
      const existing = await prisma.workItemTypeField.findUnique({
        where: {
          workItemTypeId_customFieldId: {
            workItemTypeId: typeId,
            customFieldId: data.customFieldId,
          },
        },
      });

      if (!existing) {
        return new Response("Field binding not found", { status: 404 });
      }

      await prisma.workItemTypeField.delete({
        where: {
          workItemTypeId_customFieldId: {
            workItemTypeId: typeId,
            customFieldId: data.customFieldId,
          },
        },
      });

      await logAudit({
        orgId,
        userId: ctx.userId,
        action: "work_item_type.field_unbound",
        entity: "work_item_type",
        entityId: typeId,
        metadata: {
          customFieldId: data.customFieldId,
          workItemTypeName: workItemType.name,
        } as Record<string, string>,
        ipAddress: getIpAddress(request),
      });

      return noContent();
    }
  } catch (error) {
    return handleApiError(error);
  }
}
