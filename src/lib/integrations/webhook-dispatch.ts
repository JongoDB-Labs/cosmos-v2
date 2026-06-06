import { createHmac } from "crypto";
import { prisma } from "@/lib/db/client";
import type { Prisma } from "@prisma/client";

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
      const signature = createHmac("sha256", hook.secret).update(body).digest("hex");

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
