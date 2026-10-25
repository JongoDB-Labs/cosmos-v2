/**
 * Is the outbox worker keeping up? The domain-event backlog (how many committed
 * changes no consumer has taken yet, and how long the oldest has waited) and
 * the webhook queue, for the instance admin's health readout
 * (/api/v1/admin/updates/settings).
 *
 * The worker normally takes an event within a second or two, so a backlog
 * whose oldest event is minutes old means it isn't running: on a deployment
 * nobody can read the logs or the database of, this is how anyone tells.
 * Counts and ages only, never an event's content.
 */
import { Prisma, type PrismaClient } from "@prisma/client";

/** Older than this, an unprocessed event means the worker has stopped. */
export const STALLED_AFTER_SECONDS = 5 * 60;

export interface EventBacklog {
  /** Committed changes not yet handed to webhooks and automations. */
  unprocessed: number;
  /** Age of the oldest of those, in whole seconds; null when there are none. */
  oldestAgeSeconds: number | null;
  /** Webhook deliveries queued or waiting to retry. */
  pendingDeliveries: number;
  /** Deliveries that gave up in the last hour. */
  failedDeliveriesLastHour: number;
}

export interface EventBacklogHealth {
  tone: "ok" | "warn" | "error" | "muted";
  headline: string;
  detail: string | null;
  backlog: EventBacklog | null;
}

export async function readEventBacklog(
  db: PrismaClient,
  now: Date = new Date(),
  /** Tests only: one org's rows, so parallel spec files don't count each other's. */
  orgId?: string,
): Promise<EventBacklog> {
  const [events] = await db.$queryRaw<{ unprocessed: bigint; oldest: Date | null }[]>`
    SELECT count(*) AS unprocessed, min(created_at) AS oldest FROM domain_events
    WHERE processed_at IS NULL ${orgId ? Prisma.sql`AND org_id = ${orgId}::uuid` : Prisma.empty}
  `;
  const [deliveries] = await db.$queryRaw<{ pending: bigint; failed: bigint }[]>`
    SELECT
      count(*) FILTER (WHERE d.status = 'PENDING' AND d.next_attempt_at IS NOT NULL) AS pending,
      count(*) FILTER (WHERE d.status = 'FAILED' AND d.last_attempt_at >= ${new Date(now.getTime() - 3_600_000)}) AS failed
    FROM webhook_deliveries d
    ${orgId ? Prisma.sql`JOIN webhooks w ON w.id = d.webhook_id AND w.org_id = ${orgId}::uuid` : Prisma.empty}
  `;
  return {
    unprocessed: Number(events.unprocessed),
    oldestAgeSeconds: events.oldest ? Math.max(0, Math.floor((now.getTime() - events.oldest.getTime()) / 1000)) : null,
    pendingDeliveries: Number(deliveries.pending),
    failedDeliveriesLastHour: Number(deliveries.failed),
  };
}

function ago(seconds: number): string {
  if (seconds < 120) return `${seconds} s`;
  if (seconds < 7_200) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3_600)} h`;
}

/** The readout for a backlog: judged on the server, whose clock wrote the events. */
export function describeEventBacklog(b: EventBacklog | null): EventBacklogHealth {
  if (!b) return { tone: "muted", headline: "Couldn't read the change-event backlog.", detail: null, backlog: null };
  const deliveries =
    b.failedDeliveriesLastHour > 0
      ? `${b.failedDeliveriesLastHour} webhook ${b.failedDeliveriesLastHour === 1 ? "delivery" : "deliveries"} gave up in the last hour.`
      : b.pendingDeliveries > 0
        ? `${b.pendingDeliveries} webhook ${b.pendingDeliveries === 1 ? "delivery" : "deliveries"} queued or waiting to retry.`
        : null;
  if (b.unprocessed > 0 && b.oldestAgeSeconds !== null && b.oldestAgeSeconds >= STALLED_AFTER_SECONDS) {
    return {
      tone: "error",
      headline: `${b.unprocessed} change ${b.unprocessed === 1 ? "event is" : "events are"} waiting; the oldest for ${ago(b.oldestAgeSeconds)}.`,
      detail: ["The event worker that runs webhooks and automations looks stopped.", deliveries].filter(Boolean).join(" "),
      backlog: b,
    };
  }
  return {
    tone: b.failedDeliveriesLastHour > 0 ? "warn" : "ok",
    headline: b.unprocessed > 0 ? `Change events are being processed (${b.unprocessed} in flight).` : "Change events are processed as they happen.",
    detail: deliveries,
    backlog: b,
  };
}

/** Read and describe, never throwing: a health readout must not take its page down. */
export async function eventBacklogHealth(db: PrismaClient, now: Date = new Date()): Promise<EventBacklogHealth> {
  try {
    return describeEventBacklog(await readEventBacklog(db, now));
  } catch {
    return describeEventBacklog(null);
  }
}
