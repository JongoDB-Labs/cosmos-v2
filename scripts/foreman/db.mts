// Foreman's IO layer: the only place in the subsystem that talks to Postgres.
// Every other foreman/ module (queue, dedup, prompt, ledger, risk, version) is a
// pure core; this file is what plugs them into the real delivery pool — every
// project any org has opted into autonomous delivery for (see deliveryProjects
// below), not a single hardcoded project/org.
import { prisma } from "@/lib/db/client";
import type { QueueItem } from "@/lib/foreman/queue";
import type { Candidate } from "@/lib/foreman/dedup";
import { buildRef } from "@/lib/foreman/ref";
import { readAutomationConfig } from "@/lib/feedback/automation-config";

/** jon@ (OWNER) — actor of record for every comment/edit Foreman makes. */
const FOREMAN_USER = "f1244511-9f53-4a78-b4d0-91851b50de2e";

/** Columns that count as "ready to build" — mirrors TODO_KEYS in src/lib/foreman/queue.ts. */
const TODO_COLUMNS = ["backlog", "todo"];
/** Columns a ticket occupies once picked up — used as the dedup history window. */
const HISTORY_COLUMNS = ["in-progress", "review", "done"];

/**
 * The pool of projects Foreman is allowed to work on: every org with
 * `autonomousDelivery.enabled` (org.settings, normalized by A3's
 * readAutomationConfig) and a non-empty `projectIds` scope, resolved to the
 * (non-archived) projects that actually exist under THAT org — `orgId` is part
 * of the resolving query, so a stale/foreign id in an org's settings can never
 * pull in another org's project. This is the single source of "what Foreman
 * works on"; every function below computes it fresh (no cache to invalidate)
 * and filters/joins against it. Ids that don't resolve (deleted, archived, or
 * belonging to a different org than the one that listed them) are skipped.
 */
export async function deliveryProjects(): Promise<
  { projectId: string; projectKey: string; orgId: string }[]
> {
  const orgs = await prisma.organization.findMany({ select: { id: true, settings: true } });

  const pool: { projectId: string; projectKey: string; orgId: string }[] = [];
  for (const org of orgs) {
    const { autonomousDelivery } = readAutomationConfig(org.settings);
    if (!autonomousDelivery.enabled || autonomousDelivery.projectIds.length === 0) continue;

    const projects = await prisma.project.findMany({
      where: { id: { in: autonomousDelivery.projectIds }, orgId: org.id, archived: false },
      select: { id: true, key: true },
    });
    for (const p of projects) pool.push({ projectId: p.id, projectKey: p.key, orgId: org.id });
  }

  // Ticket refs are `<projectKey>-<n>`, and project keys are only unique PER ORG
  // (`@@unique([orgId, key])`). If two pooled projects across different orgs share a
  // key, that ref is ambiguous — reconcileGated's `resolveTicket(key, n)` could land
  // on the wrong org's item and move/comment on it. Until refs carry the org, keep
  // the pool's keys globally unique: drop every entry for any colliding key and log
  // it, so an ambiguous ref can never resolve. (No effect in the common single-org /
  // distinct-key case.)
  const keyCounts = new Map<string, number>();
  for (const p of pool) keyCounts.set(p.projectKey, (keyCounts.get(p.projectKey) ?? 0) + 1);
  const ambiguous = new Set([...keyCounts].filter(([, n]) => n > 1).map(([k]) => k));
  if (ambiguous.size > 0) {
    console.warn(
      `[foreman] delivery pool has projects sharing a key across orgs (${[...ambiguous].join(", ")}) — ` +
        `excluding them until keys are globally unique (rename or unscope one).`,
    );
    return pool.filter((p) => !ambiguous.has(p.projectKey));
  }
  return pool;
}

/**
 * Backlog items ready to be picked up, across every project in the delivery
 * pool, with the AI triage classification from the feedback-remediation loop
 * (src/lib/feedback/remediate.ts) attached where one exists. `WorkItem` has no
 * `triage` column — the classification lives on the `FeedbackItem` row that
 * delivered the ticket (`feedback_items.work_item_id`). There's no Prisma
 * relation between the two models (`FeedbackItem.workItemId` is a plain,
 * unconstrained uuid — see prisma/schema.prisma), so it's joined here with a
 * second query and merged in memory. Backlog tickets filed by hand (not via the
 * feedback portal) have no matching row and get `triage: null`.
 *
 * Each item also carries `projectKey` + `orgId`, looked up from the pool by the
 * item's `projectId` — the contract run.mts needs to build a per-project ref
 * (`<KEY>-<n>`, via buildRef) and to know which org a comment/ship belongs to.
 */
export async function getBacklog(): Promise<
  Array<
    QueueItem & { title: string; description: string; triage: unknown; projectKey: string; orgId: string }
  >
> {
  const pool = await deliveryProjects();
  if (pool.length === 0) return [];
  const poolByProjectId = new Map(pool.map((p) => [p.projectId, p]));

  const rows = await prisma.workItem.findMany({
    where: { projectId: { in: pool.map((p) => p.projectId) }, columnKey: { in: TODO_COLUMNS } },
    select: {
      id: true,
      projectId: true,
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

  // flatMap (not map) so a row whose projectId somehow isn't in the pool map —
  // can't happen given the `where` above is scoped to pool project ids, but the
  // lookup is still a `Map.get` — is dropped instead of producing a bad entry.
  return rows.flatMap((r) => {
    const p = poolByProjectId.get(r.projectId);
    if (!p) return [];
    return [
      {
        id: r.id,
        ticketNumber: r.ticketNumber,
        priority: r.priority as QueueItem["priority"],
        columnKey: r.columnKey,
        columnEnteredAt: (r.columnEnteredAt ?? new Date(0)).toISOString(),
        title: r.title,
        description: r.description,
        triage: triageByItem.get(r.id) ?? null,
        projectKey: p.projectKey,
        orgId: p.orgId,
      },
    ];
  });
}

/** Resolve a `<projectKey>-<ticketNumber>` ref's number half to its work-item id
 *  + current column + org, scoped to the delivery pool (ticket numbers are only
 *  unique per-project, so the key is required to land on exactly one item).
 *  Project keys are only unique per-org (`@@unique([orgId, key])`), so more than
 *  one pool entry can share a `projectKey` across different orgs — resolved with
 *  a single query scoped to every matching pool project id, then the winning
 *  row's `projectId` maps back to its pool entry for the org. Null if the key
 *  matches no pool project, or no item in those project(s) has that number. */
export async function resolveTicket(
  projectKey: string,
  ticketNumber: number,
): Promise<{ id: string; columnKey: string; orgId: string } | null> {
  const entries = (await deliveryProjects()).filter((p) => p.projectKey === projectKey);
  if (entries.length === 0) return null;

  const row = await prisma.workItem.findFirst({
    where: { projectId: { in: entries.map((e) => e.projectId) }, ticketNumber },
    select: { id: true, columnKey: true, projectId: true },
  });
  if (!row) return null;

  const entry = entries.find((e) => e.projectId === row.projectId);
  if (!entry) return null; // unreachable: row.projectId came from entries' own id list
  return { id: row.id, columnKey: row.columnKey, orgId: entry.orgId };
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
 *  audit log (e.g. column moves), untouched by this module. The org is read off
 *  the item itself (`WorkItem.orgId` is a direct column — prisma/schema.prisma)
 *  rather than a fixed constant, since Foreman now spans every org in the pool. */
export async function comment(itemId: string, body: string): Promise<void> {
  const item = await prisma.workItem.findUnique({ where: { id: itemId }, select: { orgId: true } });
  if (!item) throw new Error(`comment: work item ${itemId} not found`);
  await prisma.comment.create({
    data: { orgId: item.orgId, workItemId: itemId, authorId: FOREMAN_USER, content: body },
  });
}

/** Global kill switch for the whole subsystem: true once at least one org is
 *  scoped into the delivery pool (autonomousDelivery.enabled with ≥1 resolved
 *  project). An org that disables the toggle, or whose projectIds all fail to
 *  resolve, drops out of the pool and this goes false with no separate flag. */
export async function autonomyEnabled(): Promise<boolean> {
  return (await deliveryProjects()).length > 0;
}

/** Items already past TODO, across every project in the delivery pool — dedup
 *  candidates so Foreman doesn't re-file a ticket for something already in
 *  flight or shipped. Ref built per-item via buildRef(<that item's projectKey>,
 *  ticketNumber), so candidates from different projects don't collide on a bare
 *  ticket number. */
export async function historyCandidates(): Promise<Candidate[]> {
  const pool = await deliveryProjects();
  if (pool.length === 0) return [];
  const poolByProjectId = new Map(pool.map((p) => [p.projectId, p]));

  const rows = await prisma.workItem.findMany({
    where: { projectId: { in: pool.map((p) => p.projectId) }, columnKey: { in: HISTORY_COLUMNS } },
    select: { projectId: true, ticketNumber: true, title: true },
  });

  return rows.flatMap((r) => {
    const p = poolByProjectId.get(r.projectId);
    if (!p) return [];
    return [{ ref: buildRef(p.projectKey, r.ticketNumber), title: r.title }];
  });
}
