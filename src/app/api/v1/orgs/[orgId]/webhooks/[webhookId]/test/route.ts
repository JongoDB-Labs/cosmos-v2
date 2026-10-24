import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { openFieldWithHeal } from "@/lib/crypto/field-seal";
import { signedRequest } from "@/lib/webhooks/deliver.server";
import { postToPublicUrl } from "@/lib/security/outbound-post.server";

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

    const data = { message: "This is a test webhook delivery from COSMOS." };
    // Open the sealed signing secret (transparent to the HMAC); self-heal a legacy
    // plaintext secret on this dispatch.
    const signingSecret = await openFieldWithHeal(webhook.secret, async (sealed) => {
      await prisma.webhook.update({ where: { id: webhook.id }, data: { secret: sealed } });
    });

    const delivery = await prisma.webhookDelivery.create({
      data: {
        webhookId,
        event: "test",
        payload: data,
        status: "PENDING",
        attempts: 1,
        lastAttemptAt: new Date(),
      },
    });

    try {
      // The same request a real delivery sends, through the same send-time
      // address check: a test is not a way to reach an internal host.
      const req = signedRequest({ event: "test", deliveryId: delivery.id, attempt: 1, payload: data, secret: signingSecret, now: new Date() });
      const response = await postToPublicUrl(webhook.url, req);
      const ok = response.status >= 200 && response.status < 300;

      const updated = await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: ok ? "SUCCESS" : "FAILED",
          statusCode: response.status,
          responseBody: response.status >= 300 && response.status < 400 ? `Redirect (${response.status}) not followed. ${response.body}`.slice(0, 1000) : response.body,
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
