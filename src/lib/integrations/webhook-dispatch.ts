import { randomUUID } from "crypto";
import { prisma } from "@/lib/db/client";
import type { Prisma } from "@prisma/client";

/**
 * Queue `event` for every active webhook of the org subscribed to it. The
 * webhook-deliveries job sends it (src/lib/webhooks/deliver.server.ts):
 * signed, retried with backoff, and only to a public address.
 *
 * Work-item events don't come through here: the outbox worker queues those
 * from the change that committed (src/lib/automation/outbox.server.ts). This
 * stays for an event with no outbox row, such as one a composed plugin raises.
 * Returns the queued delivery ids.
 */
export async function dispatchWebhook(orgId: string, event: string, payload: Record<string, unknown>): Promise<string[]> {
  const hooks = await prisma.webhook.findMany({
    where: { orgId, active: true, events: { has: event } },
    select: { id: true },
  });
  return Promise.all(hooks.map((hook) => queueDelivery(hook.id, event, payload)));
}

/** Queue one delivery to one webhook, whatever it subscribes to (an automation's webhook action). Returns its id. */
export async function queueDelivery(webhookId: string, event: string, payload: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await prisma.webhookDelivery.create({
    data: { id, webhookId, event, payload: { id, ...payload } as Prisma.InputJsonValue, status: "PENDING", nextAttemptAt: new Date() },
  });
  return id;
}
