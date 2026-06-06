import { createHmac } from "crypto";
import { prisma } from "@/lib/db/client";
import type { Prisma } from "@prisma/client";
import { openFieldWithHeal } from "@/lib/crypto/field-seal";

export async function dispatchWebhook(
  orgId: string,
  event: string,
  payload: Record<string, unknown>
) {
  const hooks = await prisma.webhook.findMany({
    where: { orgId, active: true, events: { has: event } },
  });

  const deliveries = await Promise.allSettled(
    hooks.map(async (hook) => {
      const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data: payload });
      // The signing secret is SEALED at rest (3.13.16). Open it to the plaintext HMAC
      // key — TRANSPARENT to the signature: the HMAC is byte-identical to before for a
      // given secret. A legacy plaintext secret (pre-sealing row) opens verbatim and
      // self-heals: it is best-effort re-sealed + re-persisted on this first dispatch.
      const signingSecret = await openFieldWithHeal(hook.secret, async (sealed) => {
        await prisma.webhook.update({ where: { id: hook.id }, data: { secret: sealed } });
      });
      const signature = createHmac("sha256", signingSecret).update(body).digest("hex");

      const delivery = await prisma.webhookDelivery.create({
        data: {
          webhookId: hook.id,
          event,
          payload: payload as Prisma.InputJsonValue,
          status: "PENDING",
          attempts: 1,
          lastAttemptAt: new Date(),
        },
      });

      try {
        const response = await fetch(hook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": `sha256=${signature}`,
            "X-Webhook-Event": event,
            "X-Webhook-Delivery": delivery.id,
          },
          body,
          signal: AbortSignal.timeout(10000),
        });

        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: response.ok ? "SUCCESS" : "FAILED",
            statusCode: response.status,
            responseBody: (await response.text()).slice(0, 1000),
          },
        });

        return delivery.id;
      } catch (err) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: "FAILED",
            responseBody: err instanceof Error ? err.message : "Unknown error",
          },
        });
        throw err;
      }
    })
  );

  return deliveries;
}
