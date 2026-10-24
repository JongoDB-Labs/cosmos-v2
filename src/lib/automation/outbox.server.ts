/**
 * The outbox worker: reads committed `domain_events` in order and hands each
 * one to its consumers, then marks it processed.
 *
 * Two consumers:
 *   - webhooks: an event becomes one queued `webhook_deliveries` row per
 *     active webhook subscribed to it, written in the same transaction that
 *     marks the event processed, so it's queued once or not at all. A worker
 *     that dies mid-batch leaves the batch unprocessed and the next run redoes
 *     it; unique(webhook_id, event_id, event) absorbs the repeat. Sending is
 *     separate (src/lib/webhooks/deliver.server.ts), so a slow endpoint never
 *     holds up the outbox.
 *   - automation rules (engine.server.ts), run while the batch is held and
 *     before it's marked processed. Each rule's actions are their own
 *     transactions; a redone event finds each rule's run row already claimed
 *     and doesn't run it again.
 *
 * Rows are claimed FOR UPDATE SKIP LOCKED, so two workers never take the same
 * event. MIGRATION events (a workflow publish moving items between statuses)
 * reach no consumer: they're bookkeeping, not something that happened to an
 * item, and a publish can move thousands at once.
 */
import { randomUUID } from "crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { webhookEventsFor } from "@/lib/webhooks/events";
import { recordOutboxLag } from "@/lib/observability/metrics";
import { runRulesForEvents, type RuleEvent } from "./engine.server";

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
  depth: number;
  caused_by_rule_id: string | null;
  created_at: Date;
}

export interface OutboxRun {
  /** Events marked processed. */
  events: number;
  /** Webhook deliveries queued. */
  queued: number;
  /** Automation rule runs recorded. */
  ruleRuns: number;
}

/** Process one batch. Returns what it did; `events < batchSize` means the outbox is drained. */
export async function processOutboxBatch(
  db: PrismaClient,
  opts: {
    batchSize?: number;
    now?: Date;
    /** Tests only: one org's events, so parallel spec files don't take each other's. */
    orgId?: string;
    /** The rules consumer; injectable for tests. */
    rules?: (events: RuleEvent[]) => Promise<number>;
  } = {},
): Promise<OutboxRun> {
  const batchSize = opts.batchSize ?? 50;
  const rules = opts.rules ?? ((events: RuleEvent[]) => runRulesForEvents(events));
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<EventRow[]>`
      SELECT id, org_id, project_id, type, subject_id, payload, actor_id, source, correlation_id, depth, caused_by_rule_id, created_at
      FROM domain_events
      WHERE processed_at IS NULL ${opts.orgId ? Prisma.sql`AND org_id = ${opts.orgId}::uuid` : Prisma.empty}
      ORDER BY id
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return { events: 0, queued: 0, ruleRuns: 0 };
    const live = rows.filter((r) => r.source !== "MIGRATION");
    const at = (opts.now ?? new Date()).getTime();
    for (const r of live) recordOutboxLag(at - r.created_at.getTime());
    const category = await statusCategories(tx, live);
    const deliveries = await webhookDeliveries(tx, live, category, opts.now ?? new Date());
    const queued = deliveries.length
      ? (await tx.webhookDelivery.createMany({ data: deliveries, skipDuplicates: true })).count
      : 0;
    const ruleRuns = await rules(
      live.map((e) => ({
        id: e.id,
        orgId: e.org_id,
        projectId: e.project_id,
        type: e.type,
        subjectId: e.subject_id,
        payload: e.payload,
        actorId: e.actor_id,
        source: e.source,
        correlationId: e.correlation_id,
        depth: e.depth,
        causedByRuleId: e.caused_by_rule_id,
        fromCategory: category.get(`${e.project_id}:${e.payload.from}`) ?? null,
        toCategory: category.get(`${e.project_id}:${e.payload.to}`) ?? null,
      })),
    );
    await tx.domainEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { processedAt: opts.now ?? new Date() } });
    return { events: rows.length, queued, ruleRuns };
  }, { timeout: 120_000 });
}

/** The category of each status a batch's transitions left or entered, by "projectId:key". Read now. */
async function statusCategories(tx: Prisma.TransactionClient, events: EventRow[]): Promise<Map<string, string>> {
  const statusKeys = events
    .filter((e) => e.type === "work_item.transitioned" && e.project_id)
    .flatMap((e) => [e.payload.from, e.payload.to].filter((k): k is string => typeof k === "string").map((key) => ({ projectId: e.project_id!, key })));
  if (statusKeys.length === 0) return new Map();
  const statuses = await tx.workflowStatus.findMany({ where: { OR: statusKeys }, select: { projectId: true, key: true, category: true } });
  return new Map(statuses.map((s) => [`${s.projectId}:${s.key}`, s.category as string]));
}

/** Process batches until the outbox is empty, the signal aborts, or `maxBatches` ran. */
export async function drainOutbox(db: PrismaClient, opts: { signal?: AbortSignal; maxBatches?: number; batchSize?: number } = {}): Promise<OutboxRun> {
  const total: OutboxRun = { events: 0, queued: 0, ruleRuns: 0 };
  const batchSize = opts.batchSize ?? 50;
  for (let i = 0; i < (opts.maxBatches ?? 50) && !opts.signal?.aborted; i++) {
    const r = await processOutboxBatch(db, { batchSize });
    total.events += r.events;
    total.queued += r.queued;
    total.ruleRuns += r.ruleRuns;
    if (r.events < batchSize) break;
  }
  return total;
}

async function webhookDeliveries(
  tx: Prisma.TransactionClient,
  events: EventRow[],
  category: Map<string, string>,
  now: Date,
): Promise<Prisma.WebhookDeliveryCreateManyInput[]> {
  if (events.length === 0) return [];
  const hooks = await tx.webhook.findMany({
    where: { orgId: { in: [...new Set(events.map((e) => e.org_id))] }, active: true },
    select: { id: true, orgId: true, events: true },
  });
  if (hooks.length === 0) return [];

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
        // The delivery's own id, in the payload too: one change can be two
        // deliveries (transitioned and completed), and a receiver dedupes on this.
        const id = randomUUID();
        rows.push({
          id,
          webhookId: hook.id,
          event: name,
          eventId: e.id,
          status: "PENDING",
          nextAttemptAt: now,
          // Ids, keys and the outbox's own payload (allowlisted values only): never a title or body.
          payload: {
            id,
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
