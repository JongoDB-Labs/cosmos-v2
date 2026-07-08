// Foreman's IO layer: the only place in the subsystem that talks to Postgres.
// Every other foreman/ module (queue, dedup, prompt, ledger, risk, version) is a
// pure core; this file is what plugs them into the real COSMOS project.
import { prisma } from "@/lib/db/client";
import type { QueueItem } from "@/lib/foreman/queue";
import type { Candidate } from "@/lib/foreman/dedup";

/** COSMOS project — Foreman only ever reads/writes this project's backlog. */
const COSMOS = "1f5916ae-765b-4409-9806-5bbdeb13ec08";
/** DEFCON AI org — owns COSMOS and the autonomousDelivery settings toggle. */
const ORG = "00e36690-cd5e-4a75-854b-00a0f471d55a";
/** jon@ (OWNER) — actor of record for every comment/edit Foreman makes. */
const FOREMAN_USER = "f1244511-9f53-4a78-b4d0-91851b50de2e";

/** Columns that count as "ready to build" — mirrors TODO_KEYS in src/lib/foreman/queue.ts. */
const TODO_COLUMNS = ["backlog", "todo"];
/** Columns a ticket occupies once picked up — used as the dedup history window. */
const HISTORY_COLUMNS = ["in-progress", "review", "done"];

interface AutonomousDeliveryConfig {
  enabled?: boolean;
}

/**
 * COSMOS backlog items ready to be picked up, with the AI triage classification
 * from the feedback-remediation loop (src/lib/feedback/remediate.ts) attached where
 * one exists. `WorkItem` has no `triage` column — the classification lives on the
 * `FeedbackItem` row that delivered the ticket (`feedback_items.work_item_id`).
 * There's no Prisma relation between the two models (`FeedbackItem.workItemId` is a
 * plain, unconstrained uuid — see prisma/schema.prisma), so it's joined here with a
 * second query and merged in memory. Backlog tickets filed by hand (not via the
 * feedback portal) have no matching row and get `triage: null`.
 */
export async function getBacklog(): Promise<
  Array<QueueItem & { title: string; description: string; triage: unknown }>
> {
  const rows = await prisma.workItem.findMany({
    where: { projectId: COSMOS, columnKey: { in: TODO_COLUMNS } },
    select: {
      id: true,
      ticketNumber: true,
      priority: true,
      columnKey: true,
      columnEnteredAt: true,
      title: true,
      description: true,
    },
  });

  const feedback = rows.length
    ? await prisma.feedbackItem.findMany({
        where: { workItemId: { in: rows.map((r) => r.id) } },
        select: { workItemId: true, triage: true },
      })
    : [];
  const triageByItem = new Map<string, unknown>();
  for (const f of feedback) if (f.workItemId) triageByItem.set(f.workItemId, f.triage);

  return rows.map((r) => ({
    id: r.id,
    ticketNumber: r.ticketNumber,
    priority: r.priority as QueueItem["priority"],
    columnKey: r.columnKey,
    columnEnteredAt: (r.columnEnteredAt ?? new Date(0)).toISOString(),
    title: r.title,
    description: r.description,
    triage: triageByItem.get(r.id) ?? null,
  }));
}

/** Move a ticket to a new column, stamping the column-entry clock the same way every
 *  other column change in the app does (drives WIP/aging displays). */
export async function moveColumn(itemId: string, columnKey: string): Promise<void> {
  await prisma.workItem.update({
    where: { id: itemId },
    data: { columnKey, columnEnteredAt: new Date() },
  });
}

/** Add a tag if not already present. `tags` is a plain text[] column (no set
 *  semantics at the DB level), so de-dup happens client-side before the write. */
export async function addTag(itemId: string, tag: string): Promise<void> {
  const wi = await prisma.workItem.findUnique({ where: { id: itemId }, select: { tags: true } });
  const tags = new Set([...(wi?.tags ?? []), tag]);
  await prisma.workItem.update({ where: { id: itemId }, data: { tags: [...tags] } });
}

/** Post a comment as Foreman. Targets the same table + column shape the
 *  card-detail sheet's comment route uses (`comments`: orgId/workItemId/authorId/
 *  content) — NOT `activities`, which is the app's separate field-change/action
 *  audit log (e.g. column moves), untouched by this module. */
export async function comment(itemId: string, body: string): Promise<void> {
  await prisma.comment.create({
    data: { orgId: ORG, workItemId: itemId, authorId: FOREMAN_USER, content: body },
  });
}

/** Global kill switch for the whole subsystem. Task 13 ships the settings UI that
 *  writes `org.settings.autonomousDelivery.enabled`; until then the key is absent
 *  and this always returns false. */
export async function autonomyEnabled(): Promise<boolean> {
  const org = await prisma.organization.findUnique({ where: { id: ORG }, select: { settings: true } });
  const cfg = ((org?.settings as Record<string, unknown>)?.autonomousDelivery ??
    {}) as AutonomousDeliveryConfig;
  return cfg.enabled === true;
}

/** COSMOS items already past TODO — dedup candidates so Foreman doesn't re-file a
 *  ticket for something already in flight or shipped. */
export async function historyCandidates(): Promise<Candidate[]> {
  const rows = await prisma.workItem.findMany({
    where: { projectId: COSMOS, columnKey: { in: HISTORY_COLUMNS } },
    select: { ticketNumber: true, title: true },
  });
  return rows.map((r) => ({ ref: `COSMOS-${r.ticketNumber}`, title: r.title }));
}
