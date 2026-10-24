/**
 * The outbox worker: reads committed `domain_events` in order and hands each
 * one to its consumers, then marks it processed.
 *
 * Today the one consumer is webhooks: an event becomes one queued
 * `webhook_deliveries` row per active webhook subscribed to it, written in the
 * same transaction that marks the event processed. So an event is queued once
 * or not at all: a worker that dies mid-batch leaves the batch unprocessed and
 * the next run redoes it, and unique(webhook_id, event_id, event) absorbs a repeat.
 * Sending is separate (src/lib/webhooks/deliver.server.ts), so a slow
 * endpoint never holds up the outbox. Automation rules join as a second
 * consumer in workflow P4b.
 *
 * Rows are claimed FOR UPDATE SKIP LOCKED, so two workers never take the same
 * event. MIGRATION events (a workflow publish moving items between statuses)
 * reach no consumer: they're bookkeeping, not something that happened to an
 * item, and a publish can move thousands at once.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { webhookEventsFor } from "@/lib/webhooks/events";

interface EventRow {
  id: bigint;
  org_id: string;
  project_id: string | null;
  type: string;
  subject_id: string;
  payload: Prisma.JsonObject;
  actor_id: string | null;
  source: string;
  correlation_id: string;
  created_at: Date;
}

export interface OutboxRun {
  /** Events marked processed. */
  events: number;
  /** Webhook deliveries queued. */
  queued: number;
}

/** Process one batch. Returns what it did; `events < batchSize` means the outbox is drained. */
export async function processOutboxBatch(
  db: PrismaClient,
  opts: { batchSize?: number; now?: Date; /** Tests only: one org's events, so parallel spec files don't take each other's. */ orgId?: string } = {},
): Promise<OutboxRun> {
  const batchSize = opts.batchSize ?? 100;
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<EventRow[]>`
      SELECT id, org_id, project_id, type, subject_id, payload, actor_id, source, correlation_id, created_at
      FROM domain_events
      WHERE processed_at IS NULL ${opts.orgId ? Prisma.sql`AND org_id = ${opts.orgId}::uuid` : Prisma.empty}
      ORDER BY id
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return { events: 0, queued: 0 };
    const live = rows.filter((r) => r.source !== "MIGRATION");
    const deliveries = await webhookDeliveries(tx, live, opts.now ?? new Date());
    const queued = deliveries.length
      ? (await tx.webhookDelivery.createMany({ data: deliveries, skipDuplicates: true })).count
      : 0;
    await tx.domainEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { processedAt: opts.now ?? new Date() } });
    return { events: rows.length, queued };
  }, { timeout: 30_000 });
}

/** Process batches until the outbox is empty, the signal aborts, or `maxBatches` ran. */
export async function drainOutbox(db: PrismaClient, opts: { signal?: AbortSignal; maxBatches?: number; batchSize?: number } = {}): Promise<OutboxRun> {
  const total: OutboxRun = { events: 0, queued: 0 };
  const batchSize = opts.batchSize ?? 100;
  for (let i = 0; i < (opts.maxBatches ?? 50) && !opts.signal?.aborted; i++) {
    const r = await processOutboxBatch(db, { batchSize });
    total.events += r.events;
    total.queued += r.queued;
    if (r.events < batchSize) break;
  }
  return total;
}

async function webhookDeliveries(tx: Prisma.TransactionClient, events: EventRow[], now: Date): Promise<Prisma.WebhookDeliveryCreateManyInput[]> {
  if (events.length === 0) return [];
  const hooks = await tx.webhook.findMany({
    where: { orgId: { in: [...new Set(events.map((e) => e.org_id))] }, active: true },
    select: { id: true, orgId: true, events: true },
  });
  if (hooks.length === 0) return [];

  // A transition's categories, read now: completed means "into a Done status".
  const statusKeys = events
    .filter((e) => e.type === "work_item.transitioned" && e.project_id)
    .flatMap((e) => [e.payload.from, e.payload.to].filter((k): k is string => typeof k === "string").map((key) => ({ projectId: e.project_id!, key })));
  const statuses = statusKeys.length
    ? await tx.workflowStatus.findMany({ where: { OR: statusKeys }, select: { projectId: true, key: true, category: true } })
    : [];
  const category = new Map(statuses.map((s) => [`${s.projectId}:${s.key}`, s.category as string]));

  // Item keys ("ENG-12"): an id alone means nothing to whoever reads the payload.
  const items = await tx.workItem.findMany({
    where: { id: { in: [...new Set(events.map((e) => e.subject_id))] } },
    select: { id: true, ticketNumber: true, project: { select: { key: true } } },
  });
  const keyOf = new Map(items.map((i) => [i.id, `${i.project.key}-${i.ticketNumber}`]));

  const rows: Prisma.WebhookDeliveryCreateManyInput[] = [];
  for (const e of events) {
    const names = webhookEventsFor({
      type: e.type,
      fromCategory: category.get(`${e.project_id}:${e.payload.from}`) ?? null,
      toCategory: category.get(`${e.project_id}:${e.payload.to}`) ?? null,
    });
    for (const hook of hooks) {
      if (hook.orgId !== e.org_id) continue;
      for (const name of names) {
        if (!hook.events.includes(name)) continue;
        rows.push({
          webhookId: hook.id,
          event: name,
          eventId: e.id,
          status: "PENDING",
          nextAttemptAt: now,
          // Ids, keys and the outbox's own payload (allowlisted values only): never a title or body.
          payload: {
            eventId: e.id.toString(),
            type: name,
            occurredAt: e.created_at.toISOString(),
            orgId: e.org_id,
            projectId: e.project_id,
            workItem: { id: e.subject_id, key: keyOf.get(e.subject_id) ?? null },
            actorId: e.actor_id,
            source: e.source,
            correlationId: e.correlation_id,
            change: e.payload,
          },
        });
      }
    }
  }
  return rows;
}
