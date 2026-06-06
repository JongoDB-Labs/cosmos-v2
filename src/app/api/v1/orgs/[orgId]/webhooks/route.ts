import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { randomBytes } from "crypto";
import { webhookUrlSchema } from "@/lib/security/webhook-url";

const createWebhookSchema = z.object({
  url: webhookUrlSchema,
  events: z.array(z.string().min(1)).min(1),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.WEBHOOK_MANAGE);

    const webhooks = await prisma.webhook.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
    });

    return success(webhooks);
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
    requirePermission(ctx, Permission.WEBHOOK_MANAGE);

    const body = await request.json();
    const data = createWebhookSchema.parse(body);

    const secret = randomBytes(32).toString("hex");

    const webhook = await prisma.webhook.create({
      data: {
        orgId,
        url: data.url,
        events: data.events,
        secret,
        active: true,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "webhook.created",
      entity: "webhook",
      entityId: webhook.id,
      metadata: { url: data.url } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(webhook);
  } catch (error) {
    return handleApiError(error);
  }
}
