import { createHash } from "node:crypto";
import type { Prisma, SyncMeeting } from "@prisma/client";
import { after } from "next/server";
import { prisma } from "@/lib/db/client";
import { logAudit } from "@/lib/audit";
import { requireAccess } from "@/lib/abac/require-access";
import { ForbiddenError, type AuthContext } from "@/lib/rbac/check";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { isProjectVisible } from "@/lib/rbac/project-access";
import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";
import { createClassificationResolver, type ClassificationResolver } from "@/lib/classification/resolver";
import { MS_CALENDAR } from "./calendar-connect";
import {
  CalendarNotConnected,
  CalendarReconnectNeeded,
  calendarConnection,
  patchCalendarMeta,
  type CalendarMeta,
} from "./calendar-token.server";
import { GraphError, GraphThrottled, graphRequest, type GraphDeps } from "./graph.server";

/**
 * COSMOS-202 (B2): Cosmos meetings mirrored into each attendee's own Outlook,
 * in a dedicated "Cosmos" calendar (never their main one), and Outlook edits
 * to those events brought back.
 *
 * Push (Cosmos -> Outlook) runs when a meeting changes; a reconcile pass in the
 * pull job retries anything that didn't land. Pull (Outlook -> Cosmos) reads a
 * calendarView delta of the Cosmos calendar. The rules:
 *  - A person gets a copy only while they may read the meeting in Cosmos
 *    (MEETING_READ and, for a project meeting, the project), the same gate as
 *    the ICS feed. Losing access removes the copy.
 *  - Echoes of our own writes are recognised by changeKey and skipped; an
 *    unchanged meeting (same event body) is not re-sent.
 *  - An Outlook edit is applied only if that person may edit the meeting in
 *    Cosmos; otherwise it is ignored, audit-logged, and the Cosmos version is
 *    pushed back over it.
 *  - Whichever side changed last wins.
 *  - Deleting the event in Outlook only detaches it; the meeting stays.
 *  - Restricted (classified) meetings go out as a bare busy block, and only a
 *    time change comes back.
 */

const CALENDAR_NAME = "Cosmos";
/** What a restricted meeting is called outside Cosmos. */
export const RESTRICTED_TITLE = "Cosmos item";
const ENTITY = "meeting";
/** The window a pull covers, re-anchored once it has drifted this far. */
const PAST_DAYS = 30;
const FUTURE_DAYS = 180;
const ROLL_DAYS = 7;
const DAY = 86_400_000;
/** At most this many Graph writes in flight for one meeting or one person. */
const CONCURRENCY = 4;
/** Bounds on what an Outlook edit may set. */
const MIN_MINUTES = 5;
const MAX_MINUTES = 24 * 60;
const MAX_TITLE = 255;

type MeetingWithAttendees = SyncMeeting & { attendees: { userId: string }[] };
export type SyncDeps = GraphDeps & { signal?: AbortSignal };

interface GraphEvent {
  id: string;
  changeKey?: string;
  subject?: string;
  start?: { dateTime: string; timeZone?: string };
  end?: { dateTime: string; timeZone?: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  lastModifiedDateTime?: string;
  "@removed"?: { reason: string };
}

const utc = (d: Date) => ({ dateTime: d.toISOString().slice(0, 23), timeZone: "UTC" });
/** Graph returns "2026-10-23T14:30:00.0000000" when asked for UTC. */
const fromGraph = (dt?: { dateTime: string }) => (dt ? new Date(dt.dateTime.replace(/(\.\d{3})\d*$/, "$1") + "Z") : null);
const linkKey = (orgId: string, userId: string, entityId: string) => ({
  orgId_provider_userId_entityType_entityId: { orgId, provider: MS_CALENDAR, userId, entityType: ENTITY, entityId },
});

/** Run `jobs` with at most `n` in flight; one failing never stops the rest. */
export async function pool<T>(items: T[], n: number, job: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++];
      try {
        await job(item);
      } catch (e) {
        if (!personal(e)) console.error("outlook sync failed:", e instanceof Error ? e.message : "unknown");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/** Errors that end one person's sync without failing anyone else's. */
const personal = (e: unknown) =>
  e instanceof CalendarNotConnected || e instanceof CalendarReconnectNeeded || e instanceof GraphThrottled || e instanceof GraphError;

// ── Who may see / edit a meeting ────────────────────────────────────────────

interface Viewer {
  /** May this person read the meeting in Cosmos (the ICS feed's gate)? */
  canSee(m: Pick<SyncMeeting, "projectId">): Promise<boolean>;
  /** May they edit it (the meeting PUT's gate)? */
  canEdit(m: Pick<SyncMeeting, "createdById" | "projectId">): Promise<boolean>;
}

async function viewerFor(orgId: string, userId: string): Promise<Viewer> {
  const eff = await loadEffectivePermissions(orgId, userId);
  if (!eff) return { canSee: async () => false, canEdit: async () => false };
  const ctx: AuthContext = {
    userId, orgId, orgRole: eff.orgRole, permissions: eff.permissions, basePermissions: eff.basePermissions,
    abacRules: eff.abacRules, isApiKey: true,
  };
  const canRead = hasPermission(ctx.permissions, Permission.MEETING_READ);
  const projects = new Map<string, Promise<boolean>>();
  return {
    async canSee(m) {
      if (!canRead) return false;
      if (!m.projectId) return true;
      if (!projects.has(m.projectId)) projects.set(m.projectId, isProjectVisible(ctx, m.projectId));
      return projects.get(m.projectId)!;
    },
    async canEdit(m) {
      try {
        await requireAccess(ctx, "MEETING_UPDATE", { createdById: m.createdById, projectId: m.projectId });
        return true;
      } catch (e) {
        if (e instanceof ForbiddenError) return false;
        throw e;
      }
    },
  };
}

// ── The person's Cosmos calendar ────────────────────────────────────────────

const creating = new Map<string, Promise<string>>();

async function findCalendarByName(orgId: string, userId: string, deps: GraphDeps): Promise<string | null> {
  const { data } = await graphRequest<{ value: { id: string; name: string }[] }>(
    orgId, userId, "GET", "/me/calendars?$select=id,name&$top=250", undefined, deps,
  );
  return data.value?.find((c) => c.name === CALENDAR_NAME)?.id ?? null;
}

/**
 * The person's "Cosmos" calendar: the one we recorded, else one already in
 * their mailbox by that name (a reconnect, another org on the same tenant, or
 * another instance racing us), else a new one. One creation per person at a
 * time here; across instances Graph's 409 for a duplicate name lands on the
 * lookup again.
 */
export async function ensureCosmosCalendar(orgId: string, userId: string, deps: GraphDeps = {}): Promise<string> {
  const conn = await calendarConnection(orgId, userId);
  if (!conn) throw new CalendarNotConnected("Outlook Calendar isn't connected.");
  if (conn.meta.calendarId) return conn.meta.calendarId;
  const k = `${orgId}:${userId}`;
  const running = creating.get(k);
  if (running) return running;
  const p = (async () => {
    let id = await findCalendarByName(orgId, userId, deps);
    if (!id) {
      try {
        id = (await graphRequest<{ id: string }>(orgId, userId, "POST", "/me/calendars", { name: CALENDAR_NAME }, deps)).data.id;
      } catch (e) {
        if (!(e instanceof GraphError && e.status === 409)) throw e;
        id = await findCalendarByName(orgId, userId, deps);
        if (!id) throw e;
      }
    }
    await patchCalendarMeta(conn.id, { calendarId: id }, ["deltaLink", "windowEnd"]);
    return id;
  })().finally(() => creating.delete(k));
  creating.set(k, p);
  return p;
}

// ── Push ────────────────────────────────────────────────────────────────────

/** The Graph event body for a meeting, as this person should see it. */
export function meetingEvent(m: SyncMeeting, restricted: boolean, link: string | null) {
  const start = m.meetingDate;
  const minutes = Math.min(Math.max(m.durationMinutes || 30, MIN_MINUTES), MAX_MINUTES);
  const end = new Date(start.getTime() + minutes * 60_000);
  if (restricted) {
    return {
      subject: RESTRICTED_TITLE, body: { contentType: "text", content: "" }, start: utc(start), end: utc(end),
      isAllDay: false, showAs: "busy", location: { displayName: "" },
    };
  }
  const lines = [link ? `Open in Cosmos: ${link}` : null, m.meetingUrl ? `Join: ${m.meetingUrl}` : null].filter(Boolean);
  return {
    subject: m.title || "Meeting",
    body: { contentType: "text", content: lines.join("\n") },
    start: utc(start),
    end: utc(end),
    isAllDay: false,
    showAs: "busy",
    location: { displayName: m.meetingUrl ?? "" },
  };
}

const bodyHash = (body: object) => createHash("sha256").update(JSON.stringify(body)).digest("base64url");

async function meetingLink(orgId: string, meta: CalendarMeta, meetingId: string): Promise<string | null> {
  if (!meta.origin) return null;
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
  return org ? `${meta.origin}/${org.slug}/meetings/${meetingId}` : null;
}

/**
 * Create or update one person's copy of a meeting and store the echo
 * changeKey. Skips the write when the body is what we last sent, unless
 * `force` (an Outlook edit we're overwriting changed it on their side).
 * The caller has already checked they may see it.
 */
async function pushFor(
  orgId: string, userId: string, m: SyncMeeting, deps: GraphDeps,
  cls: ClassificationResolver, force = false,
): Promise<void> {
  const conn = await calendarConnection(orgId, userId);
  if (!conn) return;
  const calendarId = await ensureCosmosCalendar(orgId, userId, deps);
  const restricted = cls.restricted(m.projectId, m.title, m.meetingUrl);
  const body = meetingEvent(m, restricted, await meetingLink(orgId, conn.meta, m.id));
  const hash = bodyHash(body);
  const existing = await prisma.externalEventLink.findUnique({ where: linkKey(orgId, userId, m.id) });
  if (existing && !force && existing.contentHash === hash && existing.externalCalendarId === calendarId) return;
  let ev: GraphEvent | null = null;
  if (existing && existing.externalCalendarId === calendarId) {
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
    where: linkKey(orgId, userId, m.id),
    create: {
      orgId, userId, provider: MS_CALENDAR, externalCalendarId: calendarId, externalEventId: ev.id,
      changeKey: ev.changeKey ?? null, contentHash: hash, entityType: ENTITY, entityId: m.id,
    },
    update: {
      externalEventId: ev.id, externalCalendarId: calendarId, changeKey: ev.changeKey ?? null,
      contentHash: hash, lastSyncedAt: new Date(),
    },
  });
}

/**
 * Delete one person's copy. The link is removed only once Outlook has it
 * gone (or never had it); on any other failure it stays, and the reconcile
 * pass in the pull job tries again.
 */
async function removeFor(orgId: string, userId: string, meetingId: string, deps: GraphDeps) {
  const link = await prisma.externalEventLink.findUnique({ where: linkKey(orgId, userId, meetingId) });
  if (!link) return;
  try {
    await graphRequest(orgId, userId, "DELETE", `/me/events/${encodeURIComponent(link.externalEventId)}`, undefined, deps);
  } catch (e) {
    if (!(e instanceof GraphError && e.status === 404)) throw e;
  }
  await prisma.externalEventLink.delete({ where: { id: link.id } });
}

/**
 * Bring every connected attendee's copy of a meeting up to date: create or
 * update it for attendees who may see it, remove it for anyone else (no longer
 * attending, lost access, or the meeting was cancelled or deleted). One
 * person's failure never stops another's. `skipUserId` is someone whose copy
 * is already current.
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
  const attending = m && m.status !== "CANCELLED" ? m.attendees.map((a) => a.userId) : [];
  const connected = attending.length
    ? (await prisma.connectorCredential.findMany({
        where: { orgId, provider: MS_CALENDAR, userId: { in: attending } },
        select: { userId: true },
      })).map((c) => c.userId as string)
    : [];
  const cls = await createClassificationResolver(orgId);
  const keep = new Set<string>();
  for (const userId of connected) if (await (await viewerFor(orgId, userId)).canSee(m!)) keep.add(userId);
  const work: (() => Promise<void>)[] = [];
  for (const userId of keep) if (userId !== skipUserId) work.push(() => pushFor(orgId, userId, m!, deps, cls));
  for (const l of links) if (!keep.has(l.userId)) work.push(() => removeFor(orgId, l.userId, meetingId, deps));
  await pool(work, CONCURRENCY, (w) => w());
}

/** The meeting fields that show in Outlook: only these changing needs a push. */
export const SYNCED_MEETING_FIELDS = ["title", "meetingDate", "durationMinutes", "meetingUrl", "status"] as const;

/** Fire-and-forget from a request: a slow or failing Microsoft never fails the edit. */
export function syncMeetingSoon(orgId: string, meetingId: string) {
  const run = () => syncMeeting(orgId, meetingId).catch((e) => console.error("outlook push failed:", e instanceof Error ? e.message : "unknown"));
  try {
    after(run); // keeps the work alive past the response
  } catch {
    void run(); // outside a request (scripts, tests)
  }
}

async function meetingActivity(orgId: string, userId: string, meetingId: string, action: string, field: string | null, oldValue: string | null, newValue: string | null) {
  await prisma.activity.create({
    data: { orgId, userId, subjectType: ENTITY, subjectId: meetingId, action, field, oldValue, newValue },
  });
}

// ── Pull ────────────────────────────────────────────────────────────────────

export interface PullResult {
  applied: number;
  ignored: number;
  echoes: number;
  detached: number;
}

/**
 * Read what changed in this person's Cosmos calendar since the last pull, and
 * bring it back by the rules above, then reconcile their copies. Resumable:
 * the delta link is saved. The window (-30d..+180d) is re-anchored once it has
 * drifted a week, so it never freezes at the day the delta started. Stops
 * between pages when `deps.signal` aborts.
 */
export async function pullChanges(orgId: string, userId: string, deps: SyncDeps = {}): Promise<PullResult> {
  const out: PullResult = { applied: 0, ignored: 0, echoes: 0, detached: 0 };
  const conn = await calendarConnection(orgId, userId);
  if (!conn?.meta.calendarId) return out;
  const now = (deps.now ?? Date.now)();
  const windowEnd = new Date(now + FUTURE_DAYS * DAY).toISOString();
  const fresh =
    `/me/calendars/${encodeURIComponent(conn.meta.calendarId)}/calendarView/delta?` +
    new URLSearchParams({ startDateTime: new Date(now - PAST_DAYS * DAY).toISOString(), endDateTime: windowEnd });
  const drifted = !conn.meta.windowEnd || Date.parse(conn.meta.windowEnd) - now < (FUTURE_DAYS - ROLL_DAYS) * DAY;
  const restarting = !conn.meta.deltaLink || drifted;
  let next: string | undefined = restarting ? fresh : conn.meta.deltaLink;
  let deltaLink: string | undefined;
  let restarted = restarting;
  const cls = await createClassificationResolver(orgId);
  const viewer = await viewerFor(orgId, userId);
  while (next) {
    if (deps.signal?.aborted) return out; // keep the old delta link: resume next run
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
    for (const ev of page.value ?? []) await applyOne(orgId, userId, ev, out, deps, cls, viewer);
    next = page["@odata.nextLink"];
    deltaLink = page["@odata.deltaLink"] ?? deltaLink;
  }
  const latest = await calendarConnection(orgId, userId);
  if (latest) {
    await patchCalendarMeta(latest.id, {
      ...(deltaLink ? { deltaLink } : {}),
      ...(restarted ? { windowEnd } : {}),
      lastSyncAt: new Date(now).toISOString(),
    });
  }
  await reconcileUser(orgId, userId, deps, cls, viewer);
  return out;
}

async function applyOne(
  orgId: string, userId: string, ev: GraphEvent, out: PullResult, deps: GraphDeps,
  cls: ClassificationResolver, viewer: Viewer,
) {
  const link = await prisma.externalEventLink.findUnique({
    where: { orgId_provider_userId_externalEventId: { orgId, provider: MS_CALENDAR, userId, externalEventId: ev.id } },
  });
  if (!link || link.entityType !== ENTITY) return; // not one of ours
  if (ev["@removed"]) {
    // Gone from the window: deleted, or moved outside it. Ask which.
    let current: GraphEvent | null = null;
    try {
      current = (await graphRequest<GraphEvent>(orgId, userId, "GET", `/me/events/${encodeURIComponent(ev.id)}`, undefined, deps)).data;
    } catch (e) {
      if (!(e instanceof GraphError && e.status === 404)) throw e;
    }
    if (!current) {
      await prisma.externalEventLink.delete({ where: { id: link.id } });
      await meetingActivity(orgId, userId, link.entityId, "outlook_detached", null, null, null);
      out.detached++;
      return;
    }
    ev = current; // moved: handle it as the edit it is
  }
  if (ev.changeKey && ev.changeKey === link.changeKey) {
    out.echoes++;
    return;
  }
  const m = await prisma.syncMeeting.findFirst({ where: { id: link.entityId, orgId } });
  if (!m || !(await viewer.canSee(m))) {
    await removeFor(orgId, userId, link.entityId, deps); // meeting gone, or no longer theirs to see
    return;
  }
  const restricted = cls.restricted(m.projectId, m.title, m.meetingUrl);
  const changes: Prisma.SyncMeetingUpdateInput = {};
  const trail: [string, string | null, string | null][] = [];
  // An all-day Outlook event has no time Cosmos can take; leave the time alone.
  const start = ev.isAllDay ? null : fromGraph(ev.start);
  const end = ev.isAllDay ? null : fromGraph(ev.end);
  if (start && start.getTime() !== m.meetingDate.getTime()) {
    changes.meetingDate = start;
    trail.push(["meetingDate", m.meetingDate.toISOString(), start.toISOString()]);
  }
  if (start && end) {
    const mins = Math.min(Math.max(Math.round((end.getTime() - start.getTime()) / 60_000), MIN_MINUTES), MAX_MINUTES);
    if (mins !== m.durationMinutes) {
      changes.durationMinutes = mins;
      trail.push(["durationMinutes", String(m.durationMinutes), String(mins)]);
    }
  }
  // A restricted meeting's title never left Cosmos, so none can come back.
  const subject = ev.subject?.trim().slice(0, MAX_TITLE);
  if (!restricted && subject && subject !== m.title && subject !== RESTRICTED_TITLE) {
    changes.title = subject;
    trail.push(["title", m.title, subject]);
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
  if (cosmosNewer || !(await viewer.canEdit(m))) {
    await logAudit({
      orgId, userId, action: "microsoft_calendar.writeback_ignored", entity: "sync_meeting", entityId: m.id,
      metadata: { reason: cosmosNewer ? "cosmos_newer" : "no_edit_rights", fields: trail.map((t) => t[0]).join(", ") },
    });
    await meetingActivity(orgId, userId, m.id, "outlook_change_ignored", trail.map((t) => t[0]).join(", "), null, cosmosNewer ? "cosmos_newer" : "no_edit_rights");
    await pushFor(orgId, userId, m, deps, cls, true); // put the Cosmos version back
    out.ignored++;
    return;
  }
  const updated = await prisma.syncMeeting.update({ where: { id: m.id }, data: changes });
  for (const [field, o, n] of trail) await meetingActivity(orgId, userId, m.id, "outlook_updated", field, o, n);
  // Their copy now matches the meeting: record that, so nothing re-sends it.
  const conn = await calendarConnection(orgId, userId);
  const hash = conn ? bodyHash(meetingEvent(updated, cls.restricted(updated.projectId, updated.title, updated.meetingUrl), await meetingLink(orgId, conn.meta, m.id))) : null;
  await prisma.externalEventLink.update({ where: { id: link.id }, data: { changeKey: ev.changeKey ?? null, contentHash: hash, lastSyncedAt: new Date() } });
  out.applied++;
  // Everyone else's copy follows; this person's is already the source.
  await syncMeeting(orgId, m.id, deps, userId);
}

// ── Reconcile ───────────────────────────────────────────────────────────────

/**
 * Make one person's Outlook match what they should have: remove copies they
 * shouldn't (meeting gone or cancelled, no longer attending, lost access),
 * including removals that failed before; push any meeting whose body changed
 * since we last wrote it (an edit whose push failed, or a classification
 * change, which no meeting update records); and add meetings in the window
 * they have no copy of. A copy they deleted in Outlook stays gone until the
 * meeting next changes.
 */
async function reconcileUser(
  orgId: string, userId: string, deps: SyncDeps, cls: ClassificationResolver, viewer: Viewer,
): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const [links, attended, detached] = await Promise.all([
    prisma.externalEventLink.findMany({
      where: { orgId, provider: MS_CALENDAR, userId, entityType: ENTITY },
      select: { entityId: true },
    }),
    prisma.syncMeeting.findMany({
      where: {
        orgId,
        status: { not: "CANCELLED" },
        attendees: { some: { userId } },
        meetingDate: { gte: new Date(now - PAST_DAYS * DAY), lte: new Date(now + FUTURE_DAYS * DAY) },
      },
    }),
    prisma.activity.findMany({
      where: { orgId, userId, subjectType: ENTITY, action: "outlook_detached" },
      select: { subjectId: true, createdAt: true },
    }),
  ]);
  const linked = new Set(links.map((l) => l.entityId));
  // Linked meetings outside the window still need checking: load them too.
  const outside = [...linked].filter((id) => !attended.some((m) => m.id === id));
  const extra = outside.length
    ? await prisma.syncMeeting.findMany({ where: { orgId, id: { in: outside } }, include: { attendees: { select: { userId: true } } } })
    : [];
  const keepIds = new Set<string>();
  const toPush: SyncMeeting[] = [];
  for (const m of [...attended, ...extra.filter((x) => x.status !== "CANCELLED" && x.attendees.some((a) => a.userId === userId))]) {
    if (!(await viewer.canSee(m))) continue;
    keepIds.add(m.id);
    if (!linked.has(m.id)) {
      const gone = detached.find((d) => d.subjectId === m.id);
      if (gone && m.updatedAt.getTime() <= gone.createdAt.getTime()) continue; // they deleted it
    }
    toPush.push(m);
  }
  const work: (() => Promise<void>)[] = [
    ...[...linked].filter((id) => !keepIds.has(id)).map((id) => () => removeFor(orgId, userId, id, deps)),
    ...toPush.map((m) => () => pushFor(orgId, userId, m, deps, cls)), // a no-op when the body is unchanged
  ];
  await pool(work, CONCURRENCY, async (w) => {
    if (deps.signal?.aborted) return;
    await w();
  });
}

/**
 * "Sync now" for one person: their Cosmos calendar (created on first use),
 * then a pull, which brings their Outlook edits back before anything is pushed
 * and ends with the reconcile pass.
 */
export async function syncUserNow(orgId: string, userId: string, deps: SyncDeps = {}): Promise<PullResult> {
  await ensureCosmosCalendar(orgId, userId, deps);
  return pullChanges(orgId, userId, deps);
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
  deps: SyncDeps & { jitterMs?: number; random?: () => number } = {},
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
 * Before a person disconnects: clear their copies out of Outlook. Usually that
 * means deleting the whole "Cosmos" calendar; but when the same Microsoft
 * account is also connected from another Cosmos org (two orgs on one tenant)
 * that calendar is shared, so only this org's events are deleted. Best effort;
 * disconnecting goes ahead whatever Microsoft says.
 */
export async function removeCosmosCalendar(orgId: string, userId: string, deps: GraphDeps = {}): Promise<boolean> {
  try {
    const conn = await calendarConnection(orgId, userId);
    if (!conn?.meta.calendarId || conn.meta.status !== "connected") return false;
    const shared = await prisma.connectorCredential.count({
      where: {
        provider: MS_CALENDAR,
        id: { not: conn.id },
        AND: [{ meta: { path: ["oid"], equals: conn.meta.oid } }, { meta: { path: ["calendarId"], equals: conn.meta.calendarId } }],
      },
    });
    if (shared > 0) {
      const links = await prisma.externalEventLink.findMany({
        where: { orgId, provider: MS_CALENDAR, userId, entityType: ENTITY },
        select: { entityId: true },
      });
      await pool(links, CONCURRENCY, (l) => removeFor(orgId, userId, l.entityId, deps));
      return true;
    }
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
