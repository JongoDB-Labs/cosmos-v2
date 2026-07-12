// Foreman's IO layer: the only place in the subsystem that talks to Postgres.
// Every other foreman/ module (queue, dedup, prompt, ledger, risk, version) is a
// pure core; this file is what plugs them into the real delivery pool — every
// project any org has opted into autonomous delivery for (see deliveryProjects
// below), not a single hardcoded project/org.
import { prisma } from "@/lib/db/client";
import { syncFeedbackForWorkItems } from "@/lib/feedback/status-sync";
import { notifyDeliveryEvent, type DeliveryEvent } from "@/lib/feedback/delivery-notify";
import type { QueueItem } from "@/lib/foreman/queue";
import type { Candidate } from "@/lib/foreman/dedup";
import { buildRef } from "@/lib/foreman/ref";
import { readAutomationConfig, MAX_DELIVERY_WORKERS } from "@/lib/feedback/automation-config";
import { extractInstructions, mentionToken, type TicketComment } from "@/lib/foreman/mention";
import { createNotification } from "@/lib/notifications/create";

/** The Foreman BOT user — the agent's own identity: its comments, board moves,
 *  and notifications are attributed to it, and @-mentioning it in a ticket
 *  comment (tag-any-entity token `<@id>`) is the instruction channel. Resolved
 *  by email at first use and cached; falls back to the maintainer's id (the
 *  pre-bot actor of record) if the bot row doesn't exist yet, so the daemon
 *  never crashes on a fresh environment. */
const FOREMAN_BOT_EMAIL = "foreman@cosmos.internal";
const FALLBACK_ACTOR = "f1244511-9f53-4a78-b4d0-91851b50de2e"; // jon@ (OWNER)
let botUserIdCache: string | null = null;
export async function botUserId(): Promise<string> {
  if (botUserIdCache) return botUserIdCache;
  const bot = await prisma.user.findFirst({ where: { email: FOREMAN_BOT_EMAIL }, select: { id: true } });
  botUserIdCache = bot?.id ?? FALLBACK_ACTOR;
  return botUserIdCache;
}

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
/** Owner notification for a delivery outcome (parked / shipped) — resolves the
 *  ticket's org and delegates to the shared app helper (bell + web push, gated
 *  by the org's Settings → Feedback automation toggles). Best-effort. */
export async function notifyDelivery(
  itemId: string,
  event: DeliveryEvent,
  info: { key: string; title: string; reason?: string; version?: string; prUrl?: string },
): Promise<void> {
  try {
    const wi = await prisma.workItem.findUnique({ where: { id: itemId }, select: { orgId: true } });
    if (!wi) return;
    await notifyDeliveryEvent(wi.orgId, event, { ...info, workItemId: itemId });
  } catch {
    /* best-effort */
  }
}

/** Atomically claim a backlog ticket for a build worker: flips backlog →
 *  in-progress only if it is STILL in the backlog, so two workers can never
 *  claim the same ticket (updateMany's count is the winner signal). */
export async function claimTicket(itemId: string): Promise<boolean> {
  const r = await prisma.workItem.updateMany({
    where: { id: itemId, columnKey: "backlog" },
    data: { columnKey: "in-progress", columnEnteredAt: new Date() },
  });
  if (r.count === 1) {
    await syncFeedbackForWorkItems([itemId], prisma as unknown as Parameters<typeof syncFeedbackForWorkItems>[1]);
    return true;
  }
  return false;
}

/** Atomically claim a PARKED (review-column) ticket for a RESUME worker: flips
 *  review → in-progress only if it is STILL in review, so draining the resume
 *  queue can't race a human drag or a second drain of the same item. Mirrors
 *  claimTicket (which guards backlog → in-progress); this is the review-column
 *  variant the approval loop's resume path uses. Carries linked feedback with the
 *  move (same as claimTicket) so a resumed ticket's feedback reads IN_PROGRESS. */
export async function claimParked(itemId: string): Promise<boolean> {
  const r = await prisma.workItem.updateMany({
    where: { id: itemId, columnKey: "review" },
    data: { columnKey: "in-progress", columnEnteredAt: new Date() },
  });
  if (r.count === 1) {
    await syncFeedbackForWorkItems([itemId], prisma as unknown as Parameters<typeof syncFeedbackForWorkItems>[1]);
    return true;
  }
  return false;
}

export async function moveColumn(itemId: string, columnKey: string): Promise<void> {
  await prisma.workItem.update({
    where: { id: itemId },
    data: { columnKey, columnEnteredAt: new Date() },
  });
  // The daemon's board moves must carry the source feedback item's status with
  // them — reporters watch feedback (PLANNED/IN_PROGRESS/DONE), not the board.
  // Best-effort inside; a sync hiccup never fails the move.
  await syncFeedbackForWorkItems([itemId], prisma as unknown as Parameters<typeof syncFeedbackForWorkItems>[1]);
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
    data: { orgId: item.orgId, workItemId: itemId, authorId: await botUserId(), content: body },
  });
}

/** Global kill switch for the whole subsystem: true once at least one org is
 *  scoped into the delivery pool (autonomousDelivery.enabled with ≥1 resolved
 *  project). An org that disables the toggle, or whose projectIds all fail to
 *  resolve, drops out of the pool and this goes false with no separate flag. */
export async function autonomyEnabled(): Promise<boolean> {
  return (await deliveryProjects()).length > 0;
}

/** Move any delivery-pool ticket left in `in-progress` back to `backlog`. A single
 *  daemon holds the LOCK, so at startup an in-progress ticket is a crashed/stranded
 *  build that nothing is working — re-queue it instead of leaving it stuck out of the
 *  pickable pool. Returns each reclaimed item's id + ref: the id lets the caller emit
 *  a per-item, org-scoped `reclaimed` event (no cross-tenant ref leak); the ref is for
 *  the aggregate log line. */
export async function reclaimStranded(): Promise<Array<{ id: string; ref: string }>> {
  const pool = await deliveryProjects();
  if (pool.length === 0) return [];
  const poolByProjectId = new Map(pool.map((p) => [p.projectId, p]));
  const rows = await prisma.workItem.findMany({
    where: { projectId: { in: pool.map((p) => p.projectId) }, columnKey: "in-progress" },
    select: { id: true, projectId: true, ticketNumber: true },
  });
  for (const r of rows) {
    await prisma.workItem.update({
      where: { id: r.id },
      data: { columnKey: "backlog", columnEnteredAt: new Date() },
    });
  }
  // The raw updates above bypass moveColumn — carry linked feedback back to
  // ground truth too (a reclaimed ticket's feedback showed IN_PROGRESS forever).
  await syncFeedbackForWorkItems(
    rows.map((r) => r.id),
    prisma as unknown as Parameters<typeof syncFeedbackForWorkItems>[1],
  );
  return rows.flatMap((r) => {
    const p = poolByProjectId.get(r.projectId);
    return p ? [{ id: r.id, ref: buildRef(p.projectKey, r.ticketNumber) }] : [];
  });
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

// ---------------------------------------------------------------------------
// @Foreman mention channel (instructions / requeue / replies)
// ---------------------------------------------------------------------------

/** OWNER/ADMIN member user-ids for an org — the only authors whose @Foreman
 *  mentions carry authority (see src/lib/foreman/mention.ts SECURITY note). */
export async function privilegedUserIds(orgId: string): Promise<Set<string>> {
  const rows = await prisma.orgMember.findMany({
    where: { orgId, role: { in: ["OWNER", "ADMIN"] } },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

/** All privileged @Foreman instructions on a ticket, oldest first — the build
 *  and clarity prompts consume the FULL history (every instruction shapes the
 *  next build, whether it arrived before the first pick or on a requeue). */
export async function instructionsFor(itemId: string): Promise<string[]> {
  const item = await prisma.workItem.findUnique({ where: { id: itemId }, select: { orgId: true } });
  if (!item) return [];
  const [bot, privileged, comments] = await Promise.all([
    botUserId(),
    privilegedUserIds(item.orgId),
    prisma.comment.findMany({
      where: { workItemId: itemId },
      select: { authorId: true, content: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  return extractInstructions(comments as TicketComment[], bot, privileged).map((i) => i.text);
}

export interface FreshMention {
  itemId: string;
  orgId: string;
  key: string; // <PROJECTKEY>-<n>
  title: string;
  description: string;
  columnKey: string;
  askerUserId: string;
  question: string;
  thread: { author: string; text: string }[];
  // The item's latest parked/gated foreman_events `data`, so run.mts (a future
  // change, not this one) can resume the SAME agent session/branch instead of
  // starting a fresh build — null when the item was never parked (or isn't in
  // `review`). `data`'s JSON round-trips an absent field as `null`, not
  // `undefined`; normalized to `undefined` here so callers can use `??`/spread
  // without `null` leaking into a rebuilt prompt or request body.
  parked: { sessionId?: string; branch?: string; prUrl?: string } | null;
}

/** kinds that mean "this ticket is sitting in review awaiting a human" — see
 *  EVENT_KINDS in src/lib/foreman/observe.ts. Only these two ever park a
 *  ticket; `needs-input`/`ship-failed`/`merged-undeployed` etc. are distinct
 *  outcomes status-read.ts's approval panel also surfaces but that this
 *  mention/park-resume channel doesn't (yet) care about. */
const PARK_EVENT_KINDS = ["parked", "gated"];

/** Normalize a parked/gated event's `data` into the FreshMention `parked`
 *  shape: absent or explicitly-null fields (a Json column round-trips an
 *  omitted field as `null`) both become `undefined`. */
function parkedInfoFromEventData(data: unknown): { sessionId?: string; branch?: string; prUrl?: string } {
  const d = (data ?? {}) as { sessionId?: string | null; branch?: string | null; prUrl?: string | null };
  return {
    sessionId: d.sessionId ?? undefined,
    branch: d.branch ?? undefined,
    prUrl: d.prUrl ?? undefined,
  };
}

/** Pool tickets with a privileged @Foreman mention that hasn't been consumed:
 *  - a ticket in `review` whose mention is newer than it ENTERED review
 *    (columnEnteredAt) → the caller requeues it (requeue resets the watermark).
 *    EVERY fresh comment past that watermark is returned, not just the first —
 *    a parked ticket can pick up several plain replies in one pass (e.g. an
 *    earlier steering note followed by a later "approved"), and run.mts's
 *    combineIntents needs the whole set to land on the right combined intent;
 *  - any other ticket whose mention is newer than the bot's own last comment
 *    on it → the caller replies (the reply becomes the new watermark). Capped
 *    to the single oldest fresh mention per pass — the Q&A path answers one
 *    question at a time.
 *  Scans the last 14 days of pool comments — the loop runs every few minutes,
 *  so the window is purely a query bound, not a semantic one. */
export async function freshMentions(): Promise<FreshMention[]> {
  const pool = await deliveryProjects();
  if (pool.length === 0) return [];
  const bot = await botUserId();
  const token = mentionToken(bot);
  const since = new Date(Date.now() - 14 * 24 * 3600_000);
  const keyByProject = new Map(pool.map((p) => [p.projectId, p.projectKey] as const));

  // Every review-column item in the pool, batched with (one query, no N+1) each
  // one's LATEST parked/gated event — the "is this ticket parked, and with what
  // session/branch/PR" lookup both the review-column token-mention path below
  // and the bare-comment ingestion path need. Reuses the batched
  // latest-event-per-item shape from src/lib/foreman/status-read.ts, simplified:
  // that read prefers the newest REASONED event (so a later blank event can't
  // blank out a reason); this one just wants the newest event, full stop —
  // `events` is ts-desc, so the first hit per item is already that.
  const reviewItems = await prisma.workItem.findMany({
    where: { projectId: { in: pool.map((p) => p.projectId) }, columnKey: "review" },
    select: {
      id: true,
      orgId: true,
      projectId: true,
      title: true,
      description: true,
      columnEnteredAt: true,
      ticketNumber: true,
    },
  });
  const reviewItemById = new Map(reviewItems.map((r) => [r.id, r] as const));
  const parkEvents = reviewItems.length
    ? await prisma.foremanEvent.findMany({
        where: { workItemId: { in: reviewItems.map((r) => r.id) }, kind: { in: PARK_EVENT_KINDS } },
        orderBy: { ts: "desc" },
        select: { workItemId: true, data: true },
      })
    : [];
  const parkedInfoByItem = new Map<string, { sessionId?: string; branch?: string; prUrl?: string }>();
  for (const e of parkEvents) {
    if (!e.workItemId || parkedInfoByItem.has(e.workItemId)) continue; // ts-desc: first hit per item wins
    parkedInfoByItem.set(e.workItemId, parkedInfoFromEventData(e.data));
  }

  const mentions = await prisma.comment.findMany({
    where: {
      createdAt: { gt: since },
      content: { contains: token },
      authorId: { not: bot },
      workItem: { projectId: { in: pool.map((p) => p.projectId) } },
    },
    select: {
      workItemId: true,
      authorId: true,
      content: true,
      createdAt: true,
      workItem: {
        select: {
          id: true,
          orgId: true,
          projectId: true,
          title: true,
          description: true,
          columnKey: true,
          columnEnteredAt: true,
          ticketNumber: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  // Each candidate is kept alongside its own comment's createdAt so the two
  // sources below (token mentions, then bare parked-ticket replies) can be
  // merged into one createdAt-ascending stream before returning — see the sort
  // at the end of this function.
  const dated: { createdAt: Date; mention: FreshMention }[] = [];
  // Caps a NON-review item to its single oldest fresh token mention per pass
  // (the Q&A reply path — one reply per pass is correct, and the bot's reply
  // becomes the new watermark). Review-column items are NOT capped here: every
  // fresh token mention on a parked ticket is pushed below, same as the
  // bare-comment loop.
  const seenNonReview = new Set<string>();
  const privCache = new Map<string, Set<string>>();
  for (const m of mentions) {
    const wi = m.workItem;
    if (!wi || !m.workItemId) continue;
    const isReview = wi.columnKey === "review";
    if (!isReview && seenNonReview.has(m.workItemId)) continue;
    let priv = privCache.get(wi.orgId);
    if (!priv) {
      priv = await privilegedUserIds(wi.orgId);
      privCache.set(wi.orgId, priv);
    }
    if (!priv.has(m.authorId)) continue;
    // Watermark: review-column tickets consume on requeue (columnEnteredAt);
    // everything else consumes on the bot's last comment.
    if (isReview) {
      if (wi.columnEnteredAt && m.createdAt.getTime() <= wi.columnEnteredAt.getTime()) continue;
    } else {
      const lastBot = await prisma.comment.findFirst({
        where: { workItemId: m.workItemId, authorId: bot },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (lastBot && m.createdAt.getTime() <= lastBot.createdAt.getTime()) continue;
    }
    // Thread context (last 12 comments) with display names, token left intact.
    const thread = await prisma.comment.findMany({
      where: { workItemId: m.workItemId },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { content: true, createdAt: true, authorId: true },
    });
    const authors = await prisma.user.findMany({
      where: { id: { in: [...new Set(thread.map((t) => t.authorId))] } },
      select: { id: true, displayName: true },
    });
    const nameOf = new Map(authors.map((a) => [a.id, a.displayName] as const));
    dated.push({
      createdAt: m.createdAt,
      mention: {
        itemId: m.workItemId,
        orgId: wi.orgId,
        key: buildRef(keyByProject.get(wi.projectId) ?? "ITEM", wi.ticketNumber),
        title: wi.title,
        description: wi.description,
        columnKey: wi.columnKey,
        askerUserId: m.authorId,
        question: m.content.split(token).join("").trim(),
        thread: thread
          .reverse()
          .map((t) => ({ author: nameOf.get(t.authorId) ?? "member", text: t.content.slice(0, 500) })),
        parked: isReview ? (parkedInfoByItem.get(m.workItemId) ?? null) : null,
      },
    });
    if (!isReview) seenNonReview.add(m.workItemId);
  }

  // Bare-comment ingestion: on a PARKED ticket, a privileged member's comment is
  // already an instruction — the ticket is sitting in front of them for
  // approval, so replying to it (no @Foreman token needed) reads the same as
  // explicitly addressing the bot. Scoped tight so a bare comment can't
  // accidentally trigger this anywhere else: item must be in `review` (not just
  // any pool item) AND have a latest parked/gated event (`parkedInfoByItem`,
  // built above from the SAME reviewItems snapshot — no separate "is it
  // parked" query), same privileged-author + review watermark rules as the
  // token path, and never the bot itself. EVERY fresh bare comment past the
  // watermark is pushed (not just the first) — a parked ticket can rack up
  // several plain replies in one pass, and all of them need to reach
  // run.mts's combineIntents. Because the query below excludes token-bearing
  // content, a comment can never satisfy both this source and the token loop
  // above, so there's nothing to dedupe by comment id between the two sources
  // (verified: the token query requires `content contains token`, this one
  // requires NOT).
  const parkedItemIds = [...parkedInfoByItem.keys()];
  const bareComments = parkedItemIds.length
    ? await prisma.comment.findMany({
        where: {
          workItemId: { in: parkedItemIds },
          createdAt: { gt: since },
          authorId: { not: bot },
          NOT: { content: { contains: token } },
        },
        select: { workItemId: true, authorId: true, content: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      })
    : [];
  for (const c of bareComments) {
    if (!c.workItemId) continue;
    const wi = reviewItemById.get(c.workItemId);
    if (!wi) continue; // defensive: parkedItemIds is derived from reviewItems, so this can't miss
    let priv = privCache.get(wi.orgId);
    if (!priv) {
      priv = await privilegedUserIds(wi.orgId);
      privCache.set(wi.orgId, priv);
    }
    if (!priv.has(c.authorId)) continue;
    // Same review-column watermark as the token path: consumed on requeue (columnEnteredAt).
    if (wi.columnEnteredAt && c.createdAt.getTime() <= wi.columnEnteredAt.getTime()) continue;
    const thread = await prisma.comment.findMany({
      where: { workItemId: c.workItemId },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { content: true, createdAt: true, authorId: true },
    });
    const authors = await prisma.user.findMany({
      where: { id: { in: [...new Set(thread.map((t) => t.authorId))] } },
      select: { id: true, displayName: true },
    });
    const nameOf = new Map(authors.map((a) => [a.id, a.displayName] as const));
    dated.push({
      createdAt: c.createdAt,
      mention: {
        itemId: c.workItemId,
        orgId: wi.orgId,
        key: buildRef(keyByProject.get(wi.projectId) ?? "ITEM", wi.ticketNumber),
        title: wi.title,
        description: wi.description,
        columnKey: "review",
        askerUserId: c.authorId,
        question: c.content.trim(),
        thread: thread
          .reverse()
          .map((t) => ({ author: nameOf.get(t.authorId) ?? "member", text: t.content.slice(0, 500) })),
        parked: parkedInfoByItem.get(c.workItemId) ?? null,
      },
    });
  }

  // A review item can now carry entries from BOTH sources above (pushed in two
  // separate passes); sort the combined stream by createdAt ascending so a
  // parked ticket's fresh comments reach run.mts — and its per-item grouping —
  // in the order they were actually written, oldest first.
  dated.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return dated.map((d) => d.mention);
}

/** Ping the asker that Foreman replied on the ticket (bell + push). */
export async function notifyReply(itemId: string, userId: string, key: string, preview: string): Promise<void> {
  try {
    const item = await prisma.workItem.findUnique({ where: { id: itemId }, select: { orgId: true } });
    if (!item) return;
    const org = await prisma.organization.findUnique({ where: { id: item.orgId }, select: { slug: true } });
    if (!org) return;
    await createNotification({
      orgId: item.orgId,
      userId,
      type: "delivery.reply",
      title: `Foreman replied on ${key}`,
      message: preview.slice(0, 180),
      relatedId: itemId,
      relatedType: "work_item",
      url: `/${org.slug}/issues?item=${itemId}`,
    });
  } catch {
    /* best-effort */
  }
}

/** A user's display name, for approval-loop attribution ("Approved by <name>").
 *  Null when the user row is gone — the caller falls back to "maintainer". One
 *  narrow lookup (displayName only). */
export async function displayName(userId: string): Promise<string | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } });
  return u?.displayName ?? null;
}

/** The feedback-triage blob (classification + acceptance criteria) for a ticket,
 *  or null when it wasn't filed via the feedback portal. The resume path needs it
 *  to rebuild a TicketBrief (for the pre-ship reviewer + the SemVer bump kind) on a
 *  review-column item that getBacklog — TODO-only — never returns. */
export async function triageFor(itemId: string): Promise<unknown> {
  const fb = await prisma.feedbackItem.findFirst({ where: { workItemId: itemId }, select: { triage: true } });
  return fb?.triage ?? null;
}

/** Ground-truth reconciler: re-derive EVERY linked feedback status in the pool
 *  orgs from its work item's current column (same mapping the live sync uses).
 *  Catches anything that bypassed moveColumn — raw updates, restarts, manual
 *  SQL — so drift can never accumulate. Runs at daemon startup. */
export async function resyncFeedbackTruth(): Promise<number> {
  const pool = await deliveryProjects();
  if (pool.length === 0) return 0;
  const orgIds = [...new Set(pool.map((p) => p.orgId))];
  const linked = await prisma.feedbackItem.findMany({
    where: { orgId: { in: orgIds }, workItemId: { not: null } },
    select: { workItemId: true },
  });
  const ids = [...new Set(linked.map((f) => f.workItemId).filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return 0;
  await syncFeedbackForWorkItems(ids, prisma as unknown as Parameters<typeof syncFeedbackForWorkItems>[1]);
  return ids.length;
}

/** LIVE parallel-build target: the max `autonomousDelivery.workers` across the
 *  enabled orgs (they share one daemon), clamped to MAX_DELIVERY_WORKERS and —
 *  as an ops guardrail — to the FOREMAN_WORKERS env cap when set. Re-read each
 *  coordinator pass so the Settings control applies without a restart. */
export async function deliveryWorkerTarget(): Promise<number> {
  const rows = await prisma.organization.findMany({
    where: { id: { in: (await deliveryProjects()).map((p) => p.orgId) } },
    select: { settings: true },
  });
  let target = 1;
  for (const r of rows) {
    const cfg = readAutomationConfig(r.settings);
    if (cfg.autonomousDelivery.enabled) target = Math.max(target, cfg.autonomousDelivery.workers);
  }
  const envCap = parseInt(process.env.FOREMAN_WORKERS ?? "", 10);
  const cap = Number.isFinite(envCap) && envCap > 0 ? Math.min(envCap, MAX_DELIVERY_WORKERS) : MAX_DELIVERY_WORKERS;
  return Math.min(Math.max(1, target), cap);
}
