import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

const widgetSchema = z.object({
  id: z.string().uuid().nullish(),
  widgetSlug: z.string().min(1).max(60),
  parentWidgetId: z.string().uuid().nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  layout: z.record(z.string(), z.unknown()).optional(),
  sortOrder: z.number().int(),
});

const syncSchema = z.object({
  widgets: z.array(widgetSchema),
});

type RouteParams = { params: Promise<{ orgId: string; templateId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, templateId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TEMPLATE_READ);

    const template = await prisma.boardTemplate.findFirst({
      where: {
        id: templateId,
        OR: [{ orgId: null }, { orgId }],
      },
    });
    if (!template) return new Response("Not found", { status: 404 });

    const widgets = await prisma.boardTemplateWidget.findMany({
      where: { templateId },
      orderBy: { sortOrder: "asc" },
    });

    return success(widgets);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, templateId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TEMPLATE_MANAGE);

    const template = await prisma.boardTemplate.findFirst({
      where: { id: templateId, orgId },
    });
    if (!template) return new Response("Not found", { status: 404 });

    if (template.isBuiltIn) {
      return new Response(
        JSON.stringify({ error: "Cannot modify built-in template widgets" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await request.json();
    const { widgets } = syncSchema.parse(body);

    const result = await prisma.$transaction(async (tx) => {
      const existingIds = (
        await tx.boardTemplateWidget.findMany({
          where: { templateId },
          select: { id: true },
        })
      ).map((w) => w.id);

      const incomingIds = widgets.filter((w) => w.id).map((w) => w.id!);
      const toDelete = existingIds.filter((id) => !incomingIds.includes(id));

      if (toDelete.length > 0) {
        await tx.boardTemplateWidget.deleteMany({
          where: { id: { in: toDelete } },
        });
      }

      for (const widget of widgets) {
        if (widget.id && existingIds.includes(widget.id)) {
          await tx.boardTemplateWidget.update({
            where: { id: widget.id },
            data: {
              widgetSlug: widget.widgetSlug,
              parentWidgetId: widget.parentWidgetId ?? null,
              config: (widget.config ?? {}) as Prisma.InputJsonValue,
              layout: (widget.layout ?? {}) as Prisma.InputJsonValue,
              sortOrder: widget.sortOrder,
            },
          });
        } else {
          await tx.boardTemplateWidget.create({
            data: {
              templateId,
              widgetSlug: widget.widgetSlug,
              parentWidgetId: widget.parentWidgetId ?? null,
              config: (widget.config ?? {}) as Prisma.InputJsonValue,
              layout: (widget.layout ?? {}) as Prisma.InputJsonValue,
              sortOrder: widget.sortOrder,
            },
          });
        }
      }

      return tx.boardTemplateWidget.findMany({
        where: { templateId },
        orderBy: { sortOrder: "asc" },
      });
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "template.widgets_updated",
      entity: "board_template",
      entityId: templateId,
      metadata: { widgetCount: String(widgets.length) } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(result);
  } catch (error) {
    return handleApiError(error);
  }
}
