import { prisma } from "@/lib/db/client";
import { logAudit } from "@/lib/audit";
import { createClassificationResolver } from "@/lib/classification/resolver";
import { entityUrl } from "@/lib/mentions/urls";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { runWorkItemQuery } from "@/lib/work-items/query/project";
import { configuredPublicOrigin } from "../hosts";
import { ConnectorError, sendToConversation, type ConnectorDeps } from "./bot-connector.server";
import { updateCard, type UpdateLine } from "./cards";
import { findItem } from "./handlers.server";
import { teamsOrgsForTenant, teamsUserById, type TeamsUser } from "./identity.server";
import { openOnly } from "./tab-data.server";
import { forgetOrgConversations } from "./conversations.server";
import { isUuid, type NotifyType } from "./outbox.server";

/**
 * COSMOS-202 T2: what the bot sends, through an outbox (teams_outbox) drained
 * by a job, so a slow or throttling Teams never holds up a Cosmos write.
 *
 * A queued row holds ids only. Everything a card says is read at SEND time,
 * as the recipient: are they still a member, still connected to Outlook in
 * the org's tenant (their mapping), does the org still have the Teams app on,
 * can they still read the item. Any "no" and nothing is sent; a lost mapping
 * or app forgets the conversation. A card carries a key, a title and a link,
 * never a description or a comment; a restricted item is its key and
 * "Restricted".
 *
 * Personal chats: the notification types each person picked (assigned to me,
 * mentioned, due tomorrow). Channels: a linked project's new items and status
 * changes, from the domain-event outbox, at most one card a minute.
 */

const HEADINGS: Record<NotifyType, string> = {
  assigned: "Assigned to you",
  mentioned: "You were mentioned",
  due_tomorrow: "Due tomorrow",
};

const MAX_ATTEMPTS = 8;
const BATCH = 50;
/** A notification a day late is noise: undelivered rows older than this are dropped. */
const STALE_MS = 24 * 60 * 60_000;
/** Per channel card. More waits for the next minute. */
const CHANNEL_LINES = 20;
/** Local hour after which the "due tomorrow" card goes out. */
const DIGEST_HOUR = 8;

// ── "Due tomorrow" ───────────────────────────────────────────────────────────

/** "YYYY-MM-DD" and the hour, in `tz` (UTC when it isn't a real zone). */
function localDay(now: Date, tz: string | null): { day: string; hour: number } {
  const parts = (zone: string) => {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
  };
  try {
    return parts(tz || "UTC");
  } catch {
    return parts("UTC");
  }
}

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Hourly: for each person who chose "due tomorrow", once a day after 8 in
 * their time zone, queue a card of what's due tomorrow (worked out at send).
 */
export async function queueDueDigests(now = new Date()): Promise<number> {
  const convs = await prisma.teamsConversation.findMany({
    where: { userId: { not: null }, notifyTypes: { has: "due_tomorrow" } },
    select: { id: true, orgId: true, userId: true, dueDigestOn: true },
  });
  // Their time zone, where they set one (Preferences, quiet hours); otherwise UTC.
  const prefs = convs.length
    ? await prisma.userPreferences.findMany({ where: { userId: { in: convs.map((c) => c.userId!) } }, select: { userId: true, dndTimezone: true } })
    : [];
  const tz = new Map(prefs.map((p) => [p.userId, p.dndTimezone]));
  let queued = 0;
  for (const c of convs) {
    const { day, hour } = localDay(now, tz.get(c.userId!) ?? null);
    if (hour < DIGEST_HOUR || c.dueDigestOn?.toISOString().slice(0, 10) === day) continue;
    // Claim the day first, so a repeated run can't queue it twice.
    const claimed = await prisma.teamsConversation.updateMany({
      where: { id: c.id, OR: [{ dueDigestOn: null }, { dueDigestOn: { not: new Date(`${day}T00:00:00Z`) } }] },
      data: { dueDigestOn: new Date(`${day}T00:00:00Z`) },
    });
    if (!claimed.count) continue;
    await prisma.teamsOutbox.create({ data: { orgId: c.orgId, teamsConversationId: c.id, kind: "due_digest", payload: { day: nextDay(day) } } });
    queued++;
  }
  return queued;
}

// ── Channels ─────────────────────────────────────────────────────────────────

const CHANNEL_EVENTS = ["work_item.created", "work_item.transitioned"] as const;

/** Can this project still post to a channel? Not once it's restricted, team-scoped or archived. */
async function channelProjectOk(projectId: string) {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, orgId: true, key: true, name: true, archived: true, teamScopedAccess: true } });
  if (!p || p.archived || p.teamScopedAccess) return null;
  const cls = await createClassificationResolver(p.orgId);
  return cls.restricted(p.id, p.name) ? null : p;
}

async function stopChannel(conv: { id: string; orgId: string; projectId: string | null }, reason: string) {
  await prisma.teamsConversation.deleteMany({ where: { id: conv.id } });
  await logAudit({ orgId: conv.orgId, action: "teams.channel_stopped", entity: "project", entityId: conv.projectId ?? undefined, metadata: { reason } });
}

/**
 * How old a channel's oldest unsent change may be before the backlog is
 * skipped rather than posted. After an outage (or with jobs not running) the
 * digest would otherwise post a card a minute about changes nobody is waiting
 * to hear about any more. The event's own time decides it, because the job
 * runner keeps no reliable "last ran": it isn't persisted, and a restart
 * resets it.
 */
export const CHANNEL_STALE_MS = 2 * 60 * 60_000;

/**
 * Every minute: for each linked channel, the project's new items and status
 * changes since its cursor, as one queued card (ids only). Changes older than
 * CHANNEL_STALE_MS are skipped: the cursor moves past the newest of them and
 * nothing is posted for them; newer ones go out on the next pass.
 */
export async function queueChannelDigests(opts: { now?: () => number } = {}): Promise<{ queued: number; skipped: number }> {
  const now = opts.now ?? Date.now;
  const convs = await prisma.teamsConversation.findMany({
    where: { projectId: { not: null } },
    select: { id: true, orgId: true, projectId: true, lastEventId: true },
  });
  let queued = 0;
  let skipped = 0;
  for (const c of convs) {
    if (!(await channelProjectOk(c.projectId!))) {
      await stopChannel(c, "project_restricted");
      continue;
    }
    const events = await prisma.domainEvent.findMany({
      where: { orgId: c.orgId, projectId: c.projectId, id: { gt: c.lastEventId ?? 0n }, type: { in: [...CHANNEL_EVENTS] } },
      orderBy: { id: "asc" },
      take: CHANNEL_LINES * 3,
      select: { id: true, type: true, subjectId: true, createdAt: true },
    });
    if (!events.length) continue;
    if (events[0].createdAt.getTime() < now() - CHANNEL_STALE_MS) {
      // Past the newest STALE change only: anything recent still gets posted
      // on the next pass, as usual.
      const lastStale = await prisma.domainEvent.findFirst({
        where: {
          orgId: c.orgId,
          projectId: c.projectId,
          id: { gt: c.lastEventId ?? 0n },
          type: { in: [...CHANNEL_EVENTS] },
          createdAt: { lt: new Date(now() - CHANNEL_STALE_MS) },
        },
        orderBy: { id: "desc" },
        select: { id: true },
      });
      const moved = await prisma.teamsConversation.updateMany({
        where: { id: c.id, lastEventId: c.lastEventId },
        data: { lastEventId: lastStale?.id ?? events[0].id },
      });
      if (moved.count) skipped++;
      continue;
    }
    // One line per item: its latest event wins ("New" if it was created in this window).
    const lines = new Map<string, "created" | "transitioned">();
    let cursor = c.lastEventId ?? 0n;
    for (const e of events) {
      if (!lines.has(e.subjectId) && lines.size >= CHANNEL_LINES) break;
      const was = lines.get(e.subjectId);
      lines.set(e.subjectId, was === "created" || e.type === "work_item.created" ? "created" : "transitioned");
      cursor = e.id;
    }
    // Advance the cursor only if no other run already did.
    const moved = await prisma.teamsConversation.updateMany({ where: { id: c.id, lastEventId: c.lastEventId }, data: { lastEventId: cursor } });
    if (!moved.count) continue;
    await prisma.teamsOutbox.create({
      data: { orgId: c.orgId, teamsConversationId: c.id, kind: "channel_digest", payload: { items: [...lines].map(([id, event]) => ({ id, event })) } },
    });
    queued++;
  }
  return { queued, skipped };
}

// ── Sending ──────────────────────────────────────────────────────────────────

type Conv = NonNullable<Awaited<ReturnType<typeof loadConversation>>>;
const loadConversation = (id: string) => prisma.teamsConversation.findUnique({ where: { id } });

/** What to do with one queued row. */
type Plan = { send: UpdateLine[]; heading: string } | { drop: string } | { forget: string };

const itemUrl = (origin: string, slug: string, ref: string) => `${origin}${entityUrl("workItem", { orgSlug: slug, id: ref })}`;

async function personalPlan(conv: Conv, row: { kind: string; payload: unknown }, origin: string): Promise<Plan> {
  const u = await teamsUserById(conv.orgId, conv.userId!, conv.tenantId);
  if (!u) return { forget: "not_mapped" };
  const p = (row.payload ?? {}) as { type?: string; workItemId?: string; day?: string };
  const cls = await createClassificationResolver(u.orgId);
  if (row.kind === "notification") {
    const type = p.type as NotifyType;
    if (!HEADINGS[type] || !conv.notifyTypes.includes(type)) return { drop: "not_chosen" };
    // Read as them, now: an item they can no longer see is not sent.
    const item = isUuid(p.workItemId) ? await findItem(u, p.workItemId) : null;
    if (!item) return { drop: "not_visible" };
    const restricted = cls.restricted(item.project.id, item.title);
    return { heading: HEADINGS[type], send: [{ ref: item.ticketKey, url: itemUrl(origin, u.slug, item.ticketKey), title: restricted ? undefined : item.title }] };
  }
  if (row.kind === "due_digest") {
    if (!conv.notifyTypes.includes("due_tomorrow") || !p.day || !/^\d{4}-\d{2}-\d{2}$/.test(p.day)) return { drop: "not_chosen" };
    const items = await dueTomorrow(u, p.day);
    if (!items.length) return { drop: "nothing_due" };
    return {
      heading: HEADINGS.due_tomorrow,
      send: items.map((i) => ({ ref: i.ticketKey, url: itemUrl(origin, u.slug, i.ticketKey), title: cls.restricted(i.project.id, i.title) ? undefined : i.title })),
    };
  }
  return { drop: "unknown_kind" };
}

/** Open items assigned to this person, due on `day`, that they can read. */
async function dueTomorrow(u: TeamsUser, day: string) {
  const readable = await getReadableProjectIds(u.auth);
  if (!readable.length) return [];
  const r = await runWorkItemQuery({
    orgId: u.orgId, allowedProjectIds: readable,
    filter: { archived: "active", assigneeIds: [u.userId], dueDate: { from: `${day}T00:00:00.000Z`, to: `${day}T23:59:59.999Z` } },
    sort: { field: "updatedAt", direction: "desc" }, page: 1, pageSize: CHANNEL_LINES,
  });
  return openOnly(r.data);
}

async function channelPlan(conv: Conv, row: { kind: string; payload: unknown }, origin: string): Promise<Plan> {
  if (row.kind !== "channel_digest") return { drop: "unknown_kind" };
  const org = (await teamsOrgsForTenant(conv.tenantId)).find((o) => o.orgId === conv.orgId);
  if (!org) return { forget: "app_off" };
  const project = await channelProjectOk(conv.projectId!);
  if (!project) return { forget: "project_restricted" };
  const wanted = (((row.payload ?? {}) as { items?: { id?: unknown; event?: unknown }[] }).items ?? []).filter((i) => isUuid(i.id));
  const items = await prisma.workItem.findMany({
    where: { id: { in: wanted.map((i) => i.id as string) }, projectId: project.id, archivedAt: null },
    select: { id: true, title: true, ticketNumber: true },
  });
  if (!items.length) return { drop: "nothing_left" };
  const cls = await createClassificationResolver(project.orgId);
  const byId = new Map(items.map((i) => [i.id, i]));
  const send: UpdateLine[] = [];
  for (const w of wanted) {
    const i = byId.get(w.id as string);
    if (!i) continue;
    const ref = `${project.key}-${i.ticketNumber}`;
    send.push({ ref, url: itemUrl(origin, org.slug, ref), title: cls.restricted(project.id, i.title) ? undefined : i.title, note: w.event === "created" ? "New" : "Status changed" });
  }
  return { heading: `${project.name} (${project.key})`, send };
}

export interface DrainResult {
  sent: number;
  dropped: number;
  retried: number;
  forgotten: number;
}

/** Send what's due in the outbox. Idempotent per row: a row is deleted once sent. */
export async function drainTeamsOutbox(opts: { signal?: AbortSignal; deps?: ConnectorDeps; now?: () => number; origin?: string | null } = {}): Promise<DrainResult & { skipped?: string }> {
  const now = opts.now ?? Date.now;
  const out: DrainResult = { sent: 0, dropped: 0, retried: 0, forgotten: 0 };
  await prisma.teamsOutbox.deleteMany({ where: { createdAt: { lt: new Date(now() - STALE_MS) } } });
  // Links in cards go to the configured public URL only, never a request's Host.
  const origin = opts.origin === undefined ? configuredPublicOrigin() : opts.origin;
  if (!origin) return { ...out, skipped: "no_public_url" };
  const rows = await prisma.teamsOutbox.findMany({ where: { nextAttemptAt: { lte: new Date(now()) } }, orderBy: { nextAttemptAt: "asc" }, take: BATCH });
  for (const row of rows) {
    if (opts.signal?.aborted) break;
    const conv = await loadConversation(row.teamsConversationId);
    if (!conv) continue; // gone, and its rows with it
    // The org turned the app off or moved tenant: nothing of it is sent, and it's all forgotten.
    if (!(await teamsOrgsForTenant(conv.tenantId)).some((o) => o.orgId === conv.orgId)) {
      await forgetOrgConversations(conv.orgId);
      out.forgotten++;
      continue;
    }
    const plan = conv.userId ? await personalPlan(conv, row, origin) : await channelPlan(conv, row, origin);
    if ("forget" in plan) {
      if (conv.projectId) await stopChannel(conv, plan.forget);
      else await prisma.teamsConversation.deleteMany({ where: { id: conv.id } });
      out.forgotten++;
      continue;
    }
    if ("drop" in plan || !plan.send.length) {
      await prisma.teamsOutbox.deleteMany({ where: { id: row.id } });
      out.dropped++;
      continue;
    }
    try {
      await sendToConversation(
        { tenantId: conv.tenantId, serviceUrl: conv.serviceUrl, conversationId: conv.conversationId },
        { attachments: [updateCard(plan.heading, plan.send)] },
        opts.deps,
      );
      await prisma.teamsOutbox.deleteMany({ where: { id: row.id } });
      out.sent++;
    } catch (e) {
      const err = e instanceof ConnectorError ? e : new ConnectorError(0, null, "send failed");
      if (err.gone) {
        // Uninstalled, or the bot was removed from that chat or team.
        if (conv.projectId) await stopChannel(conv, "bot_removed");
        else await prisma.teamsConversation.deleteMany({ where: { id: conv.id } });
        out.forgotten++;
      } else if (err.retryable && row.attempts + 1 < MAX_ATTEMPTS) {
        // Teams' Retry-After when it gave one; otherwise back off, doubling from 30s.
        const wait = Math.max(err.retryAfterMs ?? 0, 30_000 * 2 ** row.attempts);
        await prisma.teamsOutbox.update({ where: { id: row.id }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(now() + wait) } });
        out.retried++;
      } else {
        await prisma.teamsOutbox.deleteMany({ where: { id: row.id } });
        out.dropped++;
      }
    }
  }
  return out;
}
