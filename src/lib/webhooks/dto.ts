import type { Prisma } from "@prisma/client";

/**
 * A webhook as the API and the settings page send it: everything but its
 * signing secret. The secret is shown once, in the response that creates the
 * webhook, and never again, sealed or open: not by a read, and not by an
 * edit's response. Every route that returns a webhook selects through this.
 */
export const WEBHOOK_PUBLIC_SELECT = {
  id: true,
  orgId: true,
  url: true,
  events: true,
  active: true,
  // Whose access it carries (src/lib/webhooks/access.server.ts).
  createdById: true,
  createdBy: { select: { displayName: true } },
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.WebhookSelect;

/** A delivery as the API sends it. `eventId` is a BigInt column, which JSON can't carry. */
export const DELIVERY_SELECT = {
  id: true,
  webhookId: true,
  event: true,
  payload: true,
  status: true,
  statusCode: true,
  responseBody: true,
  attempts: true,
  lastAttemptAt: true,
  nextAttemptAt: true,
  eventId: true,
  createdAt: true,
} as const satisfies Prisma.WebhookDeliverySelect;

type DeliveryRow = Prisma.WebhookDeliveryGetPayload<{ select: typeof DELIVERY_SELECT }>;

export function toDeliveryDto(d: DeliveryRow) {
  return { ...d, eventId: d.eventId === null ? null : d.eventId.toString() };
}
