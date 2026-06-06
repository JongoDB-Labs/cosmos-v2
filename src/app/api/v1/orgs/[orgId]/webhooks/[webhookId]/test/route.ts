import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { createHmac } from "crypto";

type RouteParams = { params: Promise<{ orgId: string; webhookId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
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

    const testPayload = {
      event: "test",
      timestamp: new Date().toISOString(),
      data: { message: "This is a test webhook delivery from COSMOS." },
    };

    const body = JSON.stringify(testPayload);
    const signature = createHmac("sha256", webhook.secret).update(body).digest("hex");

    const delivery = await prisma.webhookDelivery.create({
      data: {
        webhookId,
        event: "test",
        payload: testPayload.data as Record<string, string>,
        status: "PENDING",
        attempts: 1,
        lastAttemptAt: new Date(),
      },
    });

    try {
      const response = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": `sha256=${signature}`,
          "X-Webhook-Event": "test",
          "X-Webhook-Delivery": delivery.id,
        },
        body,
        signal: AbortSignal.timeout(10000),
      });

      const responseBody = (await response.text()).slice(0, 1000);

      const updated = await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: response.ok ? "SUCCESS" : "FAILED",
          statusCode: response.status,
          responseBody,
        },
      });

      await logAudit({
        orgId,
        userId: ctx.userId,
        action: "webhook.tested",
        entity: "webhook",
        entityId: webhookId,
        metadata: { deliveryId: delivery.id, status: updated.status } as Record<string, string>,
        ipAddress: getIpAddress(request),
      });

      return success(updated);
    } catch (err) {
      const updated = await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "FAILED",
          responseBody: err instanceof Error ? err.message : "Unknown error",
        },
      });

      return success(updated);
    }
  } catch (error) {
    return handleApiError(error);
  }
}
