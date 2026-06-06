import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { Prisma } from "@prisma/client";

const patchBoardTemplateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().nullish(),
  category: z.string().min(1).max(100).optional(),
  boardType: z.string().min(1).max(50).optional(),
  defaultConfig: z.record(z.string(), z.unknown()).optional(),
  sortOrder: z.number().int().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; templateId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, templateId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_READ);

    const template = await prisma.boardTemplate.findUnique({
      where: { id: templateId },
      include: {
        widgets: true,
      },
    });

    if (!template) return new Response("Not found", { status: 404 });

    // Only return if built-in (available to everyone) or owned by this org
    if (!template.isBuiltIn && template.orgId !== orgId) {
      return new Response("Not found", { status: 404 });
    }

    return success(template);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, templateId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_TEMPLATES);

    const template = await prisma.boardTemplate.findUnique({ where: { id: templateId } });
    if (!template) return new Response("Not found", { status: 404 });
    if (template.orgId !== orgId) return new Response("Not found", { status: 404 });

    if (template.isBuiltIn) {
      return new Response(
        JSON.stringify({ error: "Cannot modify built-in templates" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await request.json();
    const data = patchBoardTemplateSchema.parse(body);

    const updated = await prisma.boardTemplate.update({
      where: { id: templateId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description ?? "" } : {}),
        ...(data.category !== undefined ? { category: data.category } : {}),
        ...(data.boardType !== undefined ? { boardType: data.boardType } : {}),
        ...(data.defaultConfig !== undefined ? { defaultConfig: data.defaultConfig as Prisma.InputJsonValue } : {}),
        ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      },
      include: {
        widgets: true,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "board_template.updated",
      entity: "board_template",
      entityId: templateId,
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
    const { orgId, templateId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_TEMPLATES);

    const template = await prisma.boardTemplate.findUnique({ where: { id: templateId } });
    if (!template) return new Response("Not found", { status: 404 });
    if (template.orgId !== orgId) return new Response("Not found", { status: 404 });

    if (template.isBuiltIn) {
      return new Response(
        JSON.stringify({ error: "Cannot delete built-in templates" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    await prisma.boardTemplate.delete({ where: { id: templateId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "board_template.deleted",
      entity: "board_template",
      entityId: templateId,
      metadata: { name: template.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
