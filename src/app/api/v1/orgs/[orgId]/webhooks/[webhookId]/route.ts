import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { webhookUrlSchema } from "@/lib/security/webhook-url";

const updateWebhookSchema = z.object({
  url: webhookUrlSchema.nullish(),
  events: z.array(z.string().min(1)).min(1).optional(),
  active: z.boolean().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; webhookId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, webhookId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.WEBHOOK_MANAGE);

    const webhook = await prisma.webhook.findFirst({
      where: { id: webhookId, orgId },
      include: {
        deliveries: {
          orderBy: { createdAt: "desc" },
          take: 20,
        },
      },
    });

    if (!webhook) return new Response("Not found", { status: 404 });

    return success(webhook);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, webhookId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.WEBHOOK_MANAGE);

    const existing = await prisma.webhook.findFirst({
      where: { id: webhookId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateWebhookSchema.parse(body);

    const updated = await prisma.webhook.update({
      where: { id: webhookId },
      data: {
        ...(data.url !== undefined && data.url !== null ? { url: data.url } : {}),
        ...(data.events !== undefined ? { events: data.events } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "webhook.updated",
      entity: "webhook",
      entityId: webhookId,
      metadata: { url: updated.url } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, webhookId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.WEBHOOK_MANAGE);

    const existing = await prisma.webhook.findFirst({
      where: { id: webhookId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateWebhookSchema.partial().parse(body);

    const updated = await prisma.webhook.update({
      where: { id: webhookId },
      data: {
        ...(data.url !== undefined && data.url !== null ? { url: data.url } : {}),
        ...(data.events !== undefined ? { events: data.events } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "webhook.patched",
      entity: "webhook",
      entityId: webhookId,
      metadata: { url: updated.url } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, webhookId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.WEBHOOK_MANAGE);

    const webhook = await prisma.webhook.findFirst({
      where: { id: webhookId, orgId },
    });
    if (!webhook) return new Response("Not found", { status: 404 });

    await prisma.webhook.delete({ where: { id: webhookId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "webhook.deleted",
      entity: "webhook",
      entityId: webhookId,
      metadata: { url: webhook.url } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
