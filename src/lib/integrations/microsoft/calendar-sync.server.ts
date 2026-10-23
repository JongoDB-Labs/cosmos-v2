import type { Prisma, SyncMeeting } from "@prisma/client";
import { after } from "next/server";
import { prisma } from "@/lib/db/client";
import { logAudit } from "@/lib/audit";
import { requireAccess } from "@/lib/abac/require-access";
import { ForbiddenError, type AuthContext } from "@/lib/rbac/check";
import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";
import { isRestricted, RESTRICTED_TITLE } from "@/lib/calendar/restricted.server";
import { MS_CALENDAR } from "./calendar-connect";
import { CalendarNotConnected, CalendarReconnectNeeded, calendarConnection, type CalendarMeta } from "./calendar-token.server";
import { GraphError, GraphThrottled, graphRequest, type GraphDeps } from "./graph.server";

/**
 * COSMOS-202 (B2): Cosmos meetings mirrored into each attendee's own Outlook,
 * in a dedicated "Cosmos" calendar (never their main one), and Outlook edits
 * to those events brought back.
 *
 * Push (Cosmos -> Outlook) runs when a meeting changes. Pull (Outlook ->
 * Cosmos) reads a calendarView delta of the Cosmos calendar. The rules:
 *  - Echoes of our own writes are recognised by changeKey and skipped.
 *  - An Outlook edit is applied only if that person may edit the meeting in
 *    Cosmos; otherwise it is ignored, audit-logged, and the Cosmos version is
 *    pushed back over it.
 *  - Whichever side changed last wins.
 *  - Deleting the event in Outlook only detaches it; the meeting stays.
 *  - Restricted (classified) meetings go out as a bare busy block, and only a
 *    time change comes back.
 */

const CALENDAR_NAME = "Cosmos";
const ENTITY = "meeting";
/** The window a pull covers. */
const PAST_DAYS = 30;
const FUTURE_DAYS = 180;
const DAY = 86_400_000;

type MeetingWithAttendees = SyncMeeting & { attendees: { userId: string }[] };

interface GraphEvent {
  id: string;
  changeKey?: string;
  subject?: string;
  start?: { dateTime: string; timeZone?: string };
  end?: { dateTime: string; timeZone?: string };
  isCancelled?: boolean;
  lastModifiedDateTime?: string;
  "@removed"?: { reason: string };
}

const utc = (d: Date) => ({ dateTime: d.toISOString().slice(0, 23), timeZone: "UTC" });
/** Graph returns "2026-10-23T14:30:00.0000000" when asked for UTC. */
const fromGraph = (dt?: { dateTime: string }) => (dt ? new Date(dt.dateTime.replace(/(\.\d{3})\d*$/, "$1") + "Z") : null);

async function saveMeta(credId: string, meta: CalendarMeta, patch: Partial<CalendarMeta>) {
  await prisma.connectorCredential.update({
    where: { id: credId },
    data: { meta: { ...meta, ...patch } as Prisma.InputJsonValue },
  });
}

/** The person's "Cosmos" calendar, created on first use. */
export async function ensureCosmosCalendar(orgId: string, userId: string, deps: GraphDeps = {}): Promise<string> {
  const conn = await calendarConnection(orgId, userId);
  if (!conn) throw new CalendarNotConnected("Outlook Calendar isn't connected.");
  if (conn.meta.calendarId) return conn.meta.calendarId;
  const { data } = await graphRequest<{ id: string }>(orgId, userId, "POST", "/me/calendars", { name: CALENDAR_NAME }, deps);
  await saveMeta(conn.id, conn.meta, { calendarId: data.id, deltaLink: undefined });
  return data.id;
}

/** The Graph event body for a meeting, as this person should see it. */
export function meetingEvent(m: SyncMeeting, restricted: boolean, link: string | null) {
  const start = m.meetingDate;
  const end = new Date(start.getTime() + (m.durationMinutes || 30) * 60_000);
  if (restricted) {
    return { subject: RESTRICTED_TITLE, body: { contentType: "text", content: "" }, start: utc(start), end: utc(end), showAs: "busy" };
  }
  const lines = [link ? `Open in Cosmos: ${link}` : null, m.meetingUrl ? `Join: ${m.meetingUrl}` : null].filter(Boolean);
  return {
    subject: m.title || "Meeting",
    body: { contentType: "text", content: lines.join("\n") },
    start: utc(start),
    end: utc(end),
    showAs: "busy",
    ...(m.meetingUrl ? { location: { displayName: m.meetingUrl } } : {}),
  };
}

async function meetingLink(orgId: string, meta: CalendarMeta, meetingId: string): Promise<string | null> {
  if (!meta.origin) return null;
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
  return org ? `${meta.origin}/${org.slug}/meetings/${meetingId}` : null;
}

/** Create or update one person's copy of a meeting; store the echo changeKey. */
async function pushFor(orgId: string, userId: string, m: SyncMeeting, deps: GraphDeps) {
  const conn = await calendarConnection(orgId, userId);
  if (!conn) return;
  const calendarId = await ensureCosmosCalendar(orgId, userId, deps);
  const restricted = await isRestricted(orgId, m.projectId, m.title);
  const body = meetingEvent(m, restricted, await meetingLink(orgId, conn.meta, m.id));
  const existing = await prisma.externalEventLink.findUnique({
    where: { orgId_provider_userId_entityType_entityId: { orgId, provider: MS_CALENDAR, userId, entityType: ENTITY, entityId: m.id } },
  });
  let ev: GraphEvent | null = null;
  if (existing) {
    try {
      ev = (await graphRequest<GraphEvent>(orgId, userId, "PATCH", `/me/events/${encodeURIComponent(existing.externalEventId)}`, body, deps)).data;
    } catch (e) {
      if (!(e instanceof GraphError && e.status === 404)) throw e; // deleted in Outlook: make a new one
    }
  }
  if (!ev) {
    // transactionId lets Graph drop a retried create. It is per meeting version,
    // so a copy someone deleted in Outlook comes back when the meeting next changes.
    ev = (
      await graphRequest<GraphEvent>(
        orgId, userId, "POST", `/me/calendars/${encodeURIComponent(calendarId)}/events`,
        { ...body, transactionId: `cosmos-${m.id}-${userId}-${m.updatedAt.getTime()}` }, deps,
      )
    ).data;
  }
  await prisma.externalEventLink.upsert({
    where: { orgId_provider_userId_entityType_entityId: { orgId, provider: MS_CALENDAR, userId, entityType: ENTITY, entityId: m.id } },
    create: {
      orgId, userId, provider: MS_CALENDAR, externalCalendarId: calendarId, externalEventId: ev.id,
      changeKey: ev.changeKey ?? null, entityType: ENTITY, entityId: m.id,
    },
    update: { externalEventId: ev.id, externalCalendarId: calendarId, changeKey: ev.changeKey ?? null, lastSyncedAt: new Date() },
  });
}

async function removeFor(orgId: string, userId: string, meetingId: string, deps: GraphDeps) {
  const link = await prisma.externalEventLink.findUnique({
    where: { orgId_provider_userId_entityType_entityId: { orgId, provider: MS_CALENDAR, userId, entityType: ENTITY, entityId: meetingId } },
  });
  if (!link) return;
  try {
    await graphRequest(orgId, userId, "DELETE", `/me/events/${encodeURIComponent(link.externalEventId)}`, undefined, deps);
  } catch (e) {
    if (!(e instanceof GraphError && e.status === 404)) throw e;
  }
  await prisma.externalEventLink.delete({ where: { id: link.id } });
}

/** Errors that end one person's sync without failing anyone else's. */
const personal = (e: unknown) =>
  e instanceof CalendarNotConnected || e instanceof CalendarReconnectNeeded || e instanceof GraphThrottled || e instanceof GraphError;

/**
 * Bring every connected attendee's copy of a meeting up to date: create or
 * update it for current attendees, remove it for people no longer attending
 * (or everyone, if the meeting was cancelled or deleted). One person's failure
 * never stops another's. `skipUserId` is someone whose copy is already current.
 */
export async function syncMeeting(orgId: string, meetingId: string, deps: GraphDeps = {}, skipUserId?: string) {
  const m = (await prisma.syncMeeting.findFirst({
    where: { id: meetingId, orgId },
    include: { attendees: { select: { userId: true } } },
  })) as MeetingWithAttendees | null;
  const links = await prisma.externalEventLink.findMany({
    where: { orgId, provider: MS_CALENDAR, entityType: ENTITY, entityId: meetingId },
    select: { userId: true },
  });
  const live = m && m.status !== "CANCELLED" ? new Set(m.attendees.map((a) => a.userId)) : new Set<string>();
  const connected = live.size
    ? (await prisma.connectorCredential.findMany({
        where: { orgId, provider: MS_CALENDAR, userId: { in: [...live] } },
        select: { userId: true },
      })).map((c) => c.userId as string)
    : [];
  const work: Promise<void>[] = [];
  for (const userId of connected) if (userId !== skipUserId) work.push(pushFor(orgId, userId, m!, deps));
  for (const l of links) if (!live.has(l.userId)) work.push(removeFor(orgId, l.userId, meetingId, deps));
  const results = await Promise.allSettled(work);
  for (const r of results) {
    if (r.status === "rejected" && !personal(r.reason)) console.error("outlook push failed:", r.reason instanceof Error ? r.reason.message : "unknown");
  }
}

/** Fire-and-forget from a request: a slow or failing Microsoft never fails the edit. */
export function syncMeetingSoon(orgId: string, meetingId: string) {
  const run = () => syncMeeting(orgId, meetingId).catch((e) => console.error("outlook push failed:", e instanceof Error ? e.message : "unknown"));
  try {
    after(run); // keeps the work alive past the response
  } catch {
    void run(); // outside a request (scripts, tests)
  }
}

/** May this person edit this meeting in Cosmos, right now? Same check as the meeting PUT. */
async function canEditMeeting(orgId: string, userId: string, m: SyncMeeting): Promise<boolean> {
  const eff = await loadEffectivePermissions(orgId, userId);
  if (!eff) return false;
  const ctx: AuthContext = {
    userId, orgId, orgRole: eff.orgRole, permissions: eff.permissions, basePermissions: eff.basePermissions,
    abacRules: eff.abacRules, isApiKey: true,
  };
  try {
    await requireAccess(ctx, "MEETING_UPDATE", { createdById: m.createdById, projectId: m.projectId });
    return true;
  } catch (e) {
    if (e instanceof ForbiddenError) return false;
    throw e;
  }
}

async function meetingActivity(orgId: string, userId: string, meetingId: string, action: string, field: string | null, oldValue: string | null, newValue: string | null) {
  await prisma.activity.create({
    data: { orgId, userId, subjectType: ENTITY, subjectId: meetingId, action, field, oldValue, newValue },
  });
}

export interface PullResult {
  applied: number;
  ignored: number;
  echoes: number;
  detached: number;
}

/**
 * Read what changed in this person's Cosmos calendar since the last pull, and
 * bring it back by the rules above. Resumable: the delta link is saved.
 */
export async function pullChanges(orgId: string, userId: string, deps: GraphDeps = {}): Promise<PullResult> {
  const out: PullResult = { applied: 0, ignored: 0, echoes: 0, detached: 0 };
  const conn = await calendarConnection(orgId, userId);
  if (!conn?.meta.calendarId) return out;
  const now = (deps.now ?? Date.now)();
  const fresh =
    `/me/calendars/${encodeURIComponent(conn.meta.calendarId)}/calendarView/delta?` +
    new URLSearchParams({
      startDateTime: new Date(now - PAST_DAYS * DAY).toISOString(),
      endDateTime: new Date(now + FUTURE_DAYS * DAY).toISOString(),
    });
  let next: string | undefined = conn.meta.deltaLink ?? fresh;
  let deltaLink: string | undefined;
  let restarted = false;
  while (next) {
    let page: { value: GraphEvent[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };
    try {
      page = (await graphRequest<typeof page>(orgId, userId, "GET", next, undefined, deps)).data;
    } catch (e) {
      // An expired delta token: start over from a full read, once.
      if (e instanceof GraphError && e.status === 410 && !restarted) {
        restarted = true;
        next = fresh;
        continue;
      }
      throw e;
    }
    for (const ev of page.value ?? []) await applyOne(orgId, userId, ev, out, deps);
    next = page["@odata.nextLink"];
    deltaLink = page["@odata.deltaLink"] ?? deltaLink;
  }
  const latest = await calendarConnection(orgId, userId);
  if (latest) await saveMeta(latest.id, latest.meta, { ...(deltaLink ? { deltaLink } : {}), lastSyncAt: new Date(now).toISOString() });
  return out;
}

async function applyOne(orgId: string, userId: string, ev: GraphEvent, out: PullResult, deps: GraphDeps) {
  const link = await prisma.externalEventLink.findUnique({
    where: { orgId_provider_userId_externalEventId: { orgId, provider: MS_CALENDAR, userId, externalEventId: ev.id } },
  });
  if (!link || link.entityType !== ENTITY) return; // not one of ours
  if (ev["@removed"]) {
    await prisma.externalEventLink.delete({ where: { id: link.id } });
    await meetingActivity(orgId, userId, link.entityId, "outlook_detached", null, null, null);
    out.detached++;
    return;
  }
  if (ev.changeKey && ev.changeKey === link.changeKey) {
    out.echoes++;
    return;
  }
  const m = await prisma.syncMeeting.findFirst({ where: { id: link.entityId, orgId } });
  if (!m) {
    await prisma.externalEventLink.delete({ where: { id: link.id } });
    return;
  }
  const restricted = await isRestricted(orgId, m.projectId, m.title);
  const start = fromGraph(ev.start);
  const end = fromGraph(ev.end);
  const changes: Prisma.SyncMeetingUpdateInput = {};
  const trail: [string, string | null, string | null][] = [];
  if (start && start.getTime() !== m.meetingDate.getTime()) {
    changes.meetingDate = start;
    trail.push(["meetingDate", m.meetingDate.toISOString(), start.toISOString()]);
  }
  if (start && end) {
    const mins = Math.round((end.getTime() - start.getTime()) / 60_000);
    if (mins > 0 && mins !== m.durationMinutes) {
      changes.durationMinutes = mins;
      trail.push(["durationMinutes", String(m.durationMinutes), String(mins)]);
    }
  }
  // A restricted meeting's title never left Cosmos, so none can come back.
  if (!restricted && ev.subject && ev.subject !== m.title && ev.subject !== RESTRICTED_TITLE) {
    changes.title = ev.subject;
    trail.push(["title", m.title, ev.subject]);
  }
  if (ev.isCancelled && m.status !== "CANCELLED") {
    changes.status = "CANCELLED";
    trail.push(["status", m.status, "CANCELLED"]);
  }

  const record = (changeKey: string | null) =>
    prisma.externalEventLink.update({ where: { id: link.id }, data: { changeKey, lastSyncedAt: new Date() } });
  if (!trail.length) {
    await record(ev.changeKey ?? null); // e.g. they set a reminder: nothing of ours changed
    return;
  }
  const outlookTime = ev.lastModifiedDateTime ? Date.parse(ev.lastModifiedDateTime) : Infinity;
  const cosmosNewer = m.updatedAt.getTime() > outlookTime;
  if (cosmosNewer || !(await canEditMeeting(orgId, userId, m))) {
    await logAudit({
      orgId, userId, action: "microsoft_calendar.writeback_ignored", entity: "sync_meeting", entityId: m.id,
      metadata: { reason: cosmosNewer ? "cosmos_newer" : "no_edit_rights", fields: trail.map((t) => t[0]).join(", ") },
    });
    await meetingActivity(orgId, userId, m.id, "outlook_change_ignored", trail.map((t) => t[0]).join(", "), null, cosmosNewer ? "cosmos_newer" : "no_edit_rights");
    await pushFor(orgId, userId, m, deps); // put the Cosmos version back
    out.ignored++;
    return;
  }
  await prisma.syncMeeting.update({ where: { id: m.id }, data: changes });
  for (const [field, o, n] of trail) await meetingActivity(orgId, userId, m.id, "outlook_updated", field, o, n);
  await record(ev.changeKey ?? null);
  out.applied++;
  // Everyone else's copy follows; this person's is already the source.
  await syncMeeting(orgId, m.id, deps, userId);
}

/**
 * "Sync now" for one person: first bring their Outlook edits back (so a push
 * can't overwrite one), then push what Outlook is missing or behind on: each
 * meeting they attend in the pull window that has no copy yet, or changed in
 * Cosmos since its copy was written. A copy they deleted in Outlook stays gone.
 */
export async function syncUserNow(orgId: string, userId: string, deps: GraphDeps = {}): Promise<PullResult> {
  const now = (deps.now ?? Date.now)();
  await ensureCosmosCalendar(orgId, userId, deps);
  const pulled = await pullChanges(orgId, userId, deps);
  const [meetings, links, detached] = await Promise.all([
    prisma.syncMeeting.findMany({
      where: {
        orgId,
        status: { not: "CANCELLED" },
        attendees: { some: { userId } },
        meetingDate: { gte: new Date(now - PAST_DAYS * DAY), lte: new Date(now + FUTURE_DAYS * DAY) },
      },
    }),
    prisma.externalEventLink.findMany({
      where: { orgId, provider: MS_CALENDAR, userId, entityType: ENTITY },
      select: { entityId: true, lastSyncedAt: true },
    }),
    prisma.activity.findMany({
      where: { orgId, userId, subjectType: ENTITY, action: "outlook_detached" },
      select: { subjectId: true, createdAt: true },
    }),
  ]);
  const synced = new Map(links.map((l) => [l.entityId, l.lastSyncedAt.getTime()]));
  const detachedAt = new Map(detached.map((d) => [d.subjectId, d.createdAt.getTime()]));
  for (const m of meetings) {
    const at = synced.get(m.id);
    if (at !== undefined ? m.updatedAt.getTime() <= at : m.updatedAt.getTime() <= (detachedAt.get(m.id) ?? -1)) continue;
    await pushFor(orgId, userId, m, deps);
  }
  return pulled;
}

export interface PullRunResult extends PullResult {
  people: number;
  throttled: number;
  failed: number;
}

/**
 * One pass over everyone connected: each person's pull is spread out by a
 * random delay so we never burst the tenant, and one person being throttled,
 * revoked or broken only ends that person's turn.
 */
export async function runCalendarPulls(
  deps: GraphDeps & { jitterMs?: number; random?: () => number; signal?: AbortSignal } = {},
): Promise<PullRunResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const jitter = deps.jitterMs ?? 2_000;
  const creds = await prisma.connectorCredential.findMany({
    where: { provider: MS_CALENDAR, userId: { not: null } },
    select: { orgId: true, userId: true, meta: true },
  });
  const out: PullRunResult = { applied: 0, ignored: 0, echoes: 0, detached: 0, people: 0, throttled: 0, failed: 0 };
  for (const c of creds.sort(() => random() - 0.5)) {
    const meta = c.meta as unknown as CalendarMeta;
    if (meta?.status !== "connected" || !meta.calendarId) continue;
    if (deps.signal?.aborted) break; // out of time: the rest go next run
    await sleep(Math.floor(random() * jitter));
    try {
      const r = await pullChanges(c.orgId, c.userId as string, deps);
      out.applied += r.applied; out.ignored += r.ignored; out.echoes += r.echoes; out.detached += r.detached;
      out.people++;
    } catch (e) {
      if (e instanceof GraphThrottled) out.throttled++;
      else {
        out.failed++;
        if (!personal(e)) console.error("outlook pull failed:", e instanceof Error ? e.message : "unknown");
      }
    }
  }
  return out;
}

/**
 * Before a person disconnects: delete the "Cosmos" calendar from their
 * Outlook, so no stale copies stay behind. Best effort; disconnecting goes
 * ahead whatever Microsoft says.
 */
export async function removeCosmosCalendar(orgId: string, userId: string, deps: GraphDeps = {}): Promise<boolean> {
  try {
    const conn = await calendarConnection(orgId, userId);
    if (!conn?.meta.calendarId || conn.meta.status !== "connected") return false;
    await graphRequest(orgId, userId, "DELETE", `/me/calendars/${encodeURIComponent(conn.meta.calendarId)}`, undefined, deps);
    return true;
  } catch {
    return false;
  }
}

/** When each person last had a lazy pull started here, so a busy page doesn't repeat it. */
const lazyPulls = new Map<string, number>();
const LAZY_PULL_EVERY_MS = 2 * 60_000;

/**
 * A freshness boost between scheduled runs: when someone opens their meetings,
 * pull their Outlook changes after the response if the last pull is stale.
 */
export function pullSoonIfStale(orgId: string, userId: string, now = Date.now(), deps: GraphDeps = {}): Promise<void> | undefined {
  const k = `${orgId}:${userId}`;
  if ((lazyPulls.get(k) ?? 0) > now - LAZY_PULL_EVERY_MS) return undefined;
  lazyPulls.set(k, now);
  if (lazyPulls.size > 10_000) lazyPulls.delete(lazyPulls.keys().next().value as string);
  const run = async () => {
    const conn = await calendarConnection(orgId, userId);
    if (!conn?.meta.calendarId || conn.meta.status !== "connected") return;
    if (conn.meta.lastSyncAt && Date.parse(conn.meta.lastSyncAt) > now - LAZY_PULL_EVERY_MS) return;
    await pullChanges(orgId, userId, deps);
  };
  const guarded = () => run().catch((e) => { if (!personal(e)) console.error("outlook pull failed:", e instanceof Error ? e.message : "unknown"); });
  try {
    after(guarded);
    return undefined;
  } catch {
    return guarded(); // outside a request (scripts, tests)
  }
}
