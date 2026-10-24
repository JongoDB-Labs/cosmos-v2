/**
 * The domain-event outbox: one `domain_events` row per change to a work item,
 * written in the same transaction as the change.
 *
 * Automations and webhooks consume these rows after commit, so nothing that
 * reacts to a change can see one that rolled back, or miss one that committed.
 * That only holds if every write records its event, which is why the single
 * writer (`write.server.ts`) takes a `WriteMeta` on every primitive and records
 * the event itself, unless the caller is the change service, which records
 * richer ones (the status a transition left and entered) and says so with
 * `RECORDED_BY_CALLER`.
 *
 * A payload carries ids, keys and the before/after of changed structural
 * fields (VALUE_FIELDS); any other field is named, never valued. Consumers
 * re-read what they show under their own actor, so an event is never a way
 * around read permissions.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

/** Who or what made a change. */
export type EventSource = "API" | "BULK" | "AI" | "IMPORT" | "SYSTEM" | "AUTOMATION" | "MIGRATION" | "PLUGIN";

export interface WriteMeta {
  /** Null for a write no person made (an import, a migration, the system). */
  actorId: string | null;
  source: EventSource;
  /** The root change, inherited by an automation's own writes to detect loops. */
  correlationId?: string;
  /** Automation chain depth: 0, the default, for a change a person or system made. */
  depth?: number;
  causedByRuleId?: string | null;
}

/**
 * What a write records when its caller names no one. The primitives keep
 * `meta` optional only so the private plugins composed into the product keep
 * compiling against them; every caller in this repository passes it, which
 * `write-meta.arch.test.ts` enforces.
 */
export const PLUGIN_WRITE: WriteMeta = { actorId: null, source: "PLUGIN" };

/** The caller records the events for this write itself (the change service). */
export const RECORDED_BY_CALLER = "recorded-by-caller" as const;
export type WriteMetaOrCaller = WriteMeta | typeof RECORDED_BY_CALLER;

export type DomainEventType = "work_item.created" | "work_item.updated" | "work_item.transitioned";

export interface DomainEventInput {
  orgId: string;
  projectId: string | null;
  type: DomainEventType;
  subjectId: string;
  payload: Prisma.InputJsonObject;
}

/**
 * The only fields whose VALUES an event copies: ids, the status key, enums,
 * numbers and dates. Every other field (title, description, notes, the cancel
 * note, resolution, custom fields, tags, an import's raw source record) is
 * named in the payload with a null value, so free text, which can be CUI,
 * never lands in the outbox. An allowlist, not a denylist: a column added to
 * work_items later is named and not valued until someone adds it here.
 */
export const VALUE_FIELDS: ReadonlySet<string> = new Set([
  // ids
  "assigneeId", "parentId", "intervalId", "teamId", "workItemTypeId", "createdById", "mergedIntoId", "projectId",
  // the status
  "columnKey",
  // enums
  "priority", "workCategory", "cancelReason",
  // numbers
  "storyPoints", "sortOrder", "ticketNumber", "originalEstimate", "remainingEstimate", "timeSpent",
  // dates
  "dueDate", "startDate", "actualStart", "completedAt", "columnEnteredAt", "archivedAt",
]);

/** A payload value for one changed field: the value for an allowlisted field, else null. */
export function eventValue(field: string, value: unknown): Prisma.InputJsonValue | null {
  if (!VALUE_FIELDS.has(field) || value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  return value as Prisma.InputJsonValue;
}

/** Insert events in the given transaction. */
export async function recordEvents(
  tx: Prisma.TransactionClient,
  meta: WriteMeta,
  events: readonly DomainEventInput[],
): Promise<void> {
  if (events.length === 0) return;
  await tx.domainEvent.createMany({
    data: events.map((e) => ({
      orgId: e.orgId,
      projectId: e.projectId,
      type: e.type,
      subjectId: e.subjectId,
      payload: e.payload,
      actorId: meta.actorId,
      source: meta.source,
      ...(meta.correlationId && { correlationId: meta.correlationId }),
      depth: meta.depth ?? 0,
      causedByRuleId: meta.causedByRuleId ?? null,
    })),
  });
}

/**
 * Run `fn` in a transaction: a new one on the root client, the caller's own on
 * a transaction client (Prisma joins a nested `$transaction` to the open one,
 * which `events.db.test.ts` pins). So a write and its event commit or roll back
 * together whichever client the caller holds.
 */
export function inTransaction<T>(
  db: Prisma.TransactionClient | PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return (db as PrismaClient).$transaction(fn);
}

/** How long an event is kept. Consumers have long processed it by then. */
export const EVENT_RETENTION_DAYS = 30;

/**
 * Delete processed events older than the retention window, a batch at a time
 * so a large backlog never holds one long lock on the table. Returns how many
 * went, and how many events are still unprocessed an hour after they were
 * written (the worker normally takes them within seconds, so that number is
 * the one to watch).
 *
 * An unprocessed event is never deleted, however old: dropping it would lose a
 * change its consumers (webhooks, automations) never saw.
 */
export async function pruneDomainEvents(
  db: PrismaClient,
  opts: { now?: Date; batchSize?: number; signal?: AbortSignal } = {},
): Promise<{ deleted: number; stuck: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - EVENT_RETENTION_DAYS * 86_400_000);
  const batchSize = opts.batchSize ?? 5_000;
  let deleted = 0;
  while (!opts.signal?.aborted) {
    const n = await db.$executeRaw`
      DELETE FROM domain_events WHERE id IN (
        SELECT id FROM domain_events
        WHERE created_at < ${cutoff} AND processed_at IS NOT NULL
        ORDER BY id LIMIT ${batchSize}
      )
    `;
    deleted += n;
    if (n < batchSize) break;
  }
  const [{ stuck }] = await db.$queryRaw<{ stuck: bigint }[]>`
    SELECT count(*) AS stuck FROM domain_events
    WHERE processed_at IS NULL AND created_at < ${new Date(now.getTime() - 3_600_000)}
  `;
  return { deleted, stuck: Number(stuck) };
}
