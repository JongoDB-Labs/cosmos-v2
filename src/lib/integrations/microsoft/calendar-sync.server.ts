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
import { rateLimit } from "@/lib/rate-limit/bucket";
import { createNotification } from "@/lib/notifications/create";
import { MS_CALENDAR } from "./calendar-connect";
import { DEFAULT_SHARING_LEVEL } from "./calendar-sharing";
import {
  CalendarNotConnected,
  CalendarReconnectNeeded,
  calendarConnection,
  onCalendarOffboard,
  orgCalendarConfig,
  patchCalendarMeta,
  sharingLevelFor,
  type CalendarMeta,
  type OffboardReason,
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
 *    time change comes back. So does anything for someone whose sharing level
 *    is free/busy only (see calendar-sharing.ts).
 */

const CALENDAR_NAME = "Cosmos";
/** What a meeting published busy-only is called outside Cosmos. */
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
  e instanceof CalendarNotConnected || e instanceof CalendarReconnectNeeded || e instanceof GraphThrottled || e instanceof GraphError ||
  e instanceof InviteDeferred;

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

/**
 * The tag we put on the calendar we create, so we only ever adopt our own: a
 * person's own "Cosmos" calendar, or one a colleague shares with them, is never
 * written to or deleted.
 */
export const COSMOS_CALENDAR_PROP = "String {15a54a29-b645-4cc8-988e-1a2322894aac} Name CosmosCalendar";
export const COSMOS_CALENDAR_TAG = "cosmos-calendar";

interface GraphCalendar {
  id: string;
  name: string;
  canEdit?: boolean;
  owner?: { address?: string };
  singleValueExtendedProperties?: { id: string; value: string }[];
}

const tagged = (c: GraphCalendar) =>
  !!c.singleValueExtendedProperties?.some((p) => p.id.toLowerCase() === COSMOS_CALENDAR_PROP.toLowerCase() && p.value === COSMOS_CALENDAR_TAG);

/**
 * Ours: tagged by us, writable, and in this person's own mailbox: its owner is
 * their UPN or their primary SMTP address (which can differ), or it is the very
 * calendar we recorded creating.
 */
const ours = (c: GraphCalendar, meta: Pick<CalendarMeta, "upn" | "mail" | "calendarId">) => {
  if (!tagged(c) || c.canEdit === false) return false;
  if (meta.calendarId && c.id === meta.calendarId) return true;
  const owner = c.owner?.address?.toLowerCase();
  if (!owner) return true;
  return [meta.upn, meta.mail].some((a) => !!a && a.toLowerCase() === owner);
};

async function listCalendars(orgId: string, userId: string, deps: GraphDeps): Promise<GraphCalendar[]> {
  const q = new URLSearchParams({
    $select: "id,name,canEdit,owner",
    $top: "250",
    $expand: `singleValueExtendedProperties($filter=id eq '${COSMOS_CALENDAR_PROP}')`,
  });
  const { data } = await graphRequest<{ value: GraphCalendar[] }>(orgId, userId, "GET", `/me/calendars?${q}`, undefined, deps);
  return data.value ?? [];
}

/** "Cosmos", or, if the person already has a calendar by that name, "Cosmos (synced)", etc. */
function freeName(cals: GraphCalendar[]): string {
  const taken = new Set(cals.map((c) => c.name.toLowerCase()));
  for (let i = 1; ; i++) {
    const name = i === 1 ? CALENDAR_NAME : i === 2 ? `${CALENDAR_NAME} (synced)` : `${CALENDAR_NAME} (synced ${i - 1})`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/**
 * The person's Cosmos calendar: the one we recorded, else the one WE created
 * earlier (tagged, theirs, writable: a reconnect, another org on the same
 * tenant, or another instance racing us), else a new tagged one, named so it
 * never collides with a calendar of theirs. One creation per person at a time
 * here; across instances a 409 lands on the lookup again.
 */
export async function ensureCosmosCalendar(orgId: string, userId: string, deps: GraphDeps = {}): Promise<string> {
  const conn = await calendarConnection(orgId, userId);
  if (!conn) throw new CalendarNotConnected("Outlook Calendar isn't connected.");
  if (conn.meta.calendarId) return conn.meta.calendarId;
  const k = `${orgId}:${userId}`;
  const running = creating.get(k);
  if (running) return running;
  const p = (async () => {
    let cals = await listCalendars(orgId, userId, deps);
    let id = cals.find((c) => ours(c, conn.meta))?.id ?? null;
    if (!id) {
      try {
        id = (
          await graphRequest<{ id: string }>(orgId, userId, "POST", "/me/calendars", {
            name: freeName(cals),
            singleValueExtendedProperties: [{ id: COSMOS_CALENDAR_PROP, value: COSMOS_CALENDAR_TAG }],
          }, deps)
        ).data.id;
      } catch (e) {
        if (!(e instanceof GraphError && e.status === 409)) throw e;
        cals = await listCalendars(orgId, userId, deps);
        id = cals.find((c) => ours(c, conn.meta))?.id ?? null;
        if (!id) throw e;
      }
    }
    await patchCalendarMeta(conn.id, { calendarId: id }, ["deltaLink", "windowEnd"]);
    return id;
  })().finally(() => creating.delete(k));
  creating.set(k, p);
  return p;
}

/** The recorded calendar is gone (deleted in Outlook): forget it, so the next ensure finds or makes one. */
async function forgetCalendar(orgId: string, userId: string) {
  const conn = await calendarConnection(orgId, userId);
  if (conn) await patchCalendarMeta(conn.id, {}, ["calendarId", "deltaLink", "windowEnd"]);
}

// ── Push ────────────────────────────────────────────────────────────────────

/**
 * The Graph event body for a meeting, as this person should see it.
 * `busyOnly`: a bare busy block, carrying no title, details or link — a
 * restricted meeting, or anyone whose sharing level is free/busy only.
 */
export function meetingEvent(m: SyncMeeting, busyOnly: boolean, link: string | null) {
  const start = m.meetingDate;
  const minutes = Math.min(Math.max(m.durationMinutes || 30, MIN_MINUTES), MAX_MINUTES);
  const end = new Date(start.getTime() + minutes * 60_000);
  if (busyOnly) {
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

// ── Invite mode ─────────────────────────────────────────────────────────────
//
// Real Outlook invitations from the organizer's calendar, per meeting, opt-in.
// The organizer's copy (their link) becomes the invitation: its content hash
// is prefixed "invite:" so it is recognised (and cancelled, not deleted) even
// after the meeting itself is gone.

const INVITE_PREFIX = "invite:";
/**
 * An invitation whose cancellation couldn't be delivered (the organizer must
 * reconnect): it stays an invitation, invite mode stays on, and the next sync
 * retries the cancellation. The reason follows the prefix.
 */
const PENDING_CANCEL = `${INVITE_PREFIX}cancel:`;
export const MAX_INVITEES = 100;
/** What a cancellation says. Never the meeting's own title, details or link. */
const CANCELLED_SUBJECT = "Meeting cancelled";
const CANCELLED_COMMENT = "This meeting was cancelled.";

export interface Invitee {
  userId: string;
  email: string;
  name: string;
}

async function withAttendees(m: SyncMeeting): Promise<MeetingWithAttendees> {
  const attendees = await prisma.meetingAttendee.findMany({ where: { meetingId: m.id }, select: { userId: true } });
  return { ...m, attendees };
}

/**
 * The meeting's attendees other than the organizer, with their addresses: only
 * active members of the meeting's org who may see the meeting (the same rule a
 * mirrored copy follows). Anyone else on the attendee list gets nothing.
 */
async function inviteesFor(m: MeetingWithAttendees): Promise<Invitee[]> {
  const ids = m.attendees.map((a) => a.userId).filter((id) => id !== m.inviteOrganizerId);
  if (!ids.length) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: ids }, deactivatedAt: null, memberships: { some: { orgId: m.orgId, removedAt: null } } },
    select: { id: true, email: true, displayName: true },
    orderBy: { email: "asc" },
  });
  const out: Invitee[] = [];
  for (const u of users) {
    if (!u.email || !(await (await viewerFor(m.orgId, u.id)).canSee(m))) continue;
    out.push({ userId: u.id, email: u.email, name: u.displayName || u.email });
  }
  return out;
}

const domainOf = (email: string) => email.split("@").pop()?.toLowerCase() ?? "";

/**
 * The org's own email domains: Security settings' allowed domains, or, when
 * that is empty, the organizer's own (UPN and primary address).
 */
export async function orgEmailDomains(orgId: string, organizer?: Pick<CalendarMeta, "upn" | "mail">): Promise<string[]> {
  const sec = await prisma.orgSecuritySettings.findUnique({ where: { orgId }, select: { allowedDomains: true } });
  const listed = (sec?.allowedDomains ?? []).map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  if (listed.length) return [...new Set(listed)];
  return [...new Set([organizer?.upn, organizer?.mail].filter((a): a is string => !!a).map(domainOf).filter(Boolean))];
}

const outside = (invitees: Invitee[], domains: string[]) =>
  domains.length ? invitees.filter((i) => !domains.includes(domainOf(i.email))) : [];

function inviteBody(base: ReturnType<typeof meetingEvent>, invitees: Invitee[]) {
  return {
    ...base,
    attendees: invitees.map((i) => ({ emailAddress: { address: i.email, name: i.name }, type: "required" })),
    responseRequested: true,
  };
}

/** One hash per part, so an update can say what changed: time.title.details.attendees */
const INVITE_PARTS = ["time", "title", "details", "attendees"] as const;
function inviteHash(b: ReturnType<typeof inviteBody>): string {
  const h = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("base64url").slice(0, 16);
  return INVITE_PREFIX + [h([b.start, b.end]), h(b.subject), h([b.body, b.location]), h(b.attendees)].join(".");
}
function changedInviteParts(before: string, after: string): string[] {
  if (!before.startsWith(INVITE_PREFIX)) return [...INVITE_PARTS];
  const a = before.slice(INVITE_PREFIX.length).split(".");
  const b = after.slice(INVITE_PREFIX.length).split(".");
  return INVITE_PARTS.filter((_, i) => a[i] !== b[i]);
}

/** Thrown when an organizer is over their invitation budget: retried by the reconcile pass. */
export class InviteDeferred extends Error {}
/** Each organizer: at most 60 writes an hour that notify people (sends, updates, cancels). */
function chargeInviteOp(organizerId: string) {
  if (!rateLimit(`ms.invite.ops:${organizerId}`, { capacity: 60, refillPerSecond: 60 / 3600 }).allowed) {
    throw new InviteDeferred("Outlook invitation limit reached; it goes out shortly.");
  }
}

async function inviteAudit(
  orgId: string, actorId: string, meetingId: string, action: string, invitees: Invitee[],
  organizer: Pick<CalendarMeta, "upn" | "mail"> | undefined, extra: Record<string, string> = {},
) {
  const away = outside(invitees, await orgEmailDomains(orgId, organizer));
  await logAudit({
    orgId, userId: actorId, action, entity: "sync_meeting", entityId: meetingId,
    // Counts and domains only: never anyone's address.
    metadata: {
      recipientCount: String(invitees.length),
      outsideDomainCount: String(away.length),
      outsideDomains: [...new Set(away.map((i) => domainOf(i.email)))].join(", "),
      ...extra,
    },
  });
}

/**
 * Cancel the organizer's event, always blanking it first, so the cancellation
 * carries nothing of the meeting. Not charged to the invitation budget: a
 * cancellation (above all a classified one) must never wait behind edits.
 */
async function cancelInviteEvent(orgId: string, userId: string, link: { externalEventId: string }, deps: GraphDeps) {
  const path = `/me/events/${encodeURIComponent(link.externalEventId)}`;
  try {
    await graphRequest(orgId, userId, "PATCH", path, {
      subject: CANCELLED_SUBJECT, body: { contentType: "text", content: "" }, location: { displayName: "" },
    }, deps);
    await graphRequest(orgId, userId, "POST", `${path}/cancel`, { comment: CANCELLED_COMMENT }, deps);
  } catch (e) {
    if (!(e instanceof GraphError && e.status === 404)) throw e; // already gone
  }
}

export type InviteStopReason =
  | "turned_off" | "classified" | "organizer_cannot_edit" | "too_many_attendees" | "organizer_not_connected"
  | "organizer_disconnected" | OffboardReason;

/**
 * Why a meeting's invitations can't go on, or null. "paused": the organizer
 * must reconnect, so nothing is sent (or stopped) meanwhile.
 */
async function inviteBlocker(orgId: string, m: MeetingWithAttendees, cls: ClassificationResolver): Promise<InviteStopReason | "paused" | null> {
  const organizer = m.inviteOrganizerId!;
  if (cls.restricted(m.projectId, m.title, m.meetingUrl)) return "classified";
  const conn = await calendarConnection(orgId, organizer);
  if (!conn) return "organizer_not_connected";
  if (conn.meta.status !== "connected") return "paused";
  const viewer = await viewerFor(orgId, organizer);
  if (!(await viewer.canEdit(m))) return "organizer_cannot_edit";
  if (m.attendees.length > MAX_INVITEES) return "too_many_attendees";
  return null;
}

/**
 * Stop a meeting's invitations: cancel the organizer's event (scrubbed first),
 * drop their link, turn invite mode off, and record why. The caller re-syncs,
 * which brings back mirrored copies.
 *
 * "pending": the cancellation couldn't be delivered (the organizer has to
 * reconnect). Nothing else changes: invite mode stays on and the invitation is
 * marked, so it is never turned into a mirror copy (its attendees would stay on
 * it), and the next sync retries. The organizer is told to reconnect.
 */
async function stopInvite(
  orgId: string, m: MeetingWithAttendees, reason: InviteStopReason, deps: GraphDeps, actorId: string,
): Promise<"stopped" | "pending"> {
  const organizer = m.inviteOrganizerId!;
  const link = await prisma.externalEventLink.findUnique({ where: linkKey(orgId, organizer, m.id) });
  const invitees = await inviteesFor(m);
  if (link?.contentHash?.startsWith(INVITE_PREFIX)) {
    try {
      await cancelInviteEvent(orgId, organizer, link, deps);
    } catch (e) {
      if (!(e instanceof CalendarNotConnected || e instanceof CalendarReconnectNeeded)) throw e;
      if (!link.contentHash.startsWith(PENDING_CANCEL)) {
        await prisma.externalEventLink.update({ where: { id: link.id }, data: { contentHash: PENDING_CANCEL + reason } });
        await createNotification({
          orgId, userId: organizer, type: "integration.outlook_invite_cancel_pending",
          title: "Reconnect Outlook to cancel invitations",
          message: "Cosmos couldn't cancel an Outlook invitation you sent. Reconnect Outlook Calendar (Settings, Preferences) and it will be cancelled.",
          relatedType: "meeting", relatedId: m.id, url: null,
        }).catch(() => undefined);
      }
      return "pending";
    }
    await prisma.externalEventLink.delete({ where: { id: link.id } });
  }
  await prisma.syncMeeting.updateMany({ where: { id: m.id, inviteOrganizerId: organizer }, data: { inviteOrganizerId: null } });
  await meetingActivity(orgId, actorId, m.id, "outlook_invite_cancelled", null, null, reason);
  const conn = await calendarConnection(orgId, organizer);
  await inviteAudit(orgId, actorId, m.id, "microsoft_calendar.invite_cancelled", invitees, conn?.meta, { organizerId: organizer, reason });
  return "stopped";
}

export interface InvitePreview {
  /** Whether the org has Outlook Calendar on at all. */
  available: boolean;
  /** Whether invite mode is on, and who sends it. */
  on: boolean;
  organizerId: string | null;
  /** May this person turn it on (or off) now; if not, why. */
  canChange: boolean;
  reason: "classified" | "not_connected" | "reconnect" | "cannot_edit" | "too_many_attendees" | "cancelled" | null;
  /** Who would get (or gets) the invitation. Only for someone who can edit the meeting; empty otherwise. */
  recipients: { name: string; email: string; outside: boolean }[];
  /** Its cancellation is waiting for the organizer to reconnect Outlook. */
  pendingCancel: boolean;
  domains: string[];
  /**
   * How invitations last ended, while off: "released" (left in Outlook, no
   * longer updated) or "cancelled", and why.
   */
  ended: { how: "released" | "cancelled"; reason: string | null; at: string } | null;
}

/** What turning on invitations for this meeting would do, as this person. */
export async function invitePreview(orgId: string, meetingId: string, actorId: string): Promise<InvitePreview | null> {
  const m = (await prisma.syncMeeting.findFirst({
    where: { id: meetingId, orgId },
    include: { attendees: { select: { userId: true } } },
  })) as MeetingWithAttendees | null;
  if (!m) return null;
  const cls = await createClassificationResolver(orgId);
  const [conn, cfg] = await Promise.all([calendarConnection(orgId, actorId), orgCalendarConfig(orgId)]);
  const asOrganizer = { ...m, inviteOrganizerId: m.inviteOrganizerId ?? actorId };
  const invitees = await inviteesFor(asOrganizer);
  const domains = await orgEmailDomains(orgId, conn?.meta);
  const away = new Set(outside(invitees, domains).map((i) => i.userId));
  const canEdit = await (await viewerFor(orgId, actorId)).canEdit(m);
  const reason: InvitePreview["reason"] =
    m.status === "CANCELLED" ? "cancelled"
    : cls.restricted(m.projectId, m.title, m.meetingUrl) ? "classified"
    : !conn ? "not_connected"
    : conn.meta.status !== "connected" ? "reconnect"
    : !canEdit ? "cannot_edit"
    : m.attendees.length > MAX_INVITEES ? "too_many_attendees"
    : null;
  const last = m.inviteOrganizerId ? null : await prisma.activity.findFirst({
    where: { orgId, subjectType: ENTITY, subjectId: m.id, action: { startsWith: "outlook_invite_" } },
    orderBy: { createdAt: "desc" },
    select: { action: true, newValue: true, createdAt: true },
  });
  const how = last?.action === "outlook_invite_released" ? "released" : last?.action === "outlook_invite_cancelled" ? "cancelled" : null;
  const own = m.inviteOrganizerId
    ? await prisma.externalEventLink.findUnique({ where: linkKey(orgId, m.inviteOrganizerId, m.id), select: { contentHash: true } })
    : null;
  return {
    available: !!cfg,
    on: !!m.inviteOrganizerId,
    organizerId: m.inviteOrganizerId,
    // Turning it off needs only edit rights; turning it on needs everything.
    canChange: m.inviteOrganizerId ? canEdit : reason === null,
    reason,
    // Addresses are for whoever may send or stop the invitation, not every reader.
    recipients: canEdit ? invitees.map((i) => ({ name: i.name, email: i.email, outside: away.has(i.userId) })) : [],
    pendingCancel: !!own?.contentHash?.startsWith(PENDING_CANCEL),
    domains,
    ended: how && last ? { how, reason: last.newValue, at: last.createdAt.toISOString() } : null,
  };
}

export class InviteRefused extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

/**
 * Turn a meeting's Outlook invitations on (as `actorId`, the organizer) or off.
 * On is refused for a classified meeting, someone not connected or unable to
 * edit it, too many attendees, or over the toggle limit (10 an hour).
 */
export async function setMeetingInvite(orgId: string, meetingId: string, actorId: string, enabled: boolean, deps: GraphDeps = {}): Promise<void> {
  if (!rateLimit(`ms.invite.toggle:${actorId}`, { capacity: 10, refillPerSecond: 10 / 3600 }).allowed) {
    throw new InviteRefused("rate_limited");
  }
  const m = (await prisma.syncMeeting.findFirst({
    where: { id: meetingId, orgId },
    include: { attendees: { select: { userId: true } } },
  })) as MeetingWithAttendees | null;
  if (!m) throw new InviteRefused("not_found");
  const viewer = await viewerFor(orgId, actorId);
  if (!(await viewer.canEdit(m))) throw new InviteRefused("cannot_edit");
  if (!enabled) {
    if (!m.inviteOrganizerId) return;
    if ((await stopInvite(orgId, m, "turned_off", deps, actorId)) === "stopped") {
      await syncMeeting(orgId, meetingId, deps); // mirrored copies come back
    }
    return;
  }
  if (m.inviteOrganizerId) {
    if (m.inviteOrganizerId === actorId) return;
    throw new InviteRefused("already_on"); // turn it off first; one organizer at a time
  }
  const preview = await invitePreview(orgId, meetingId, actorId);
  if (!preview || preview.reason) throw new InviteRefused(preview?.reason ?? "not_found");
  // Atomic: of two people turning it on at once, one wins and the other is told.
  const claimed = await prisma.syncMeeting.updateMany({ where: { id: meetingId, orgId, inviteOrganizerId: null }, data: { inviteOrganizerId: actorId } });
  if (!claimed.count) throw new InviteRefused("already_on");
  await meetingActivity(orgId, actorId, meetingId, "outlook_invite_on", null, null, null);
  await syncMeeting(orgId, meetingId, deps);
}

/** Upcoming meetings whose invitations this person sends. */
export async function liveInvites(orgId: string, userId: string, now = Date.now()) {
  return prisma.syncMeeting.findMany({
    where: { orgId, inviteOrganizerId: userId, status: { not: "CANCELLED" }, meetingDate: { gte: new Date(now - DAY) } },
    include: { attendees: { select: { userId: true } } },
  }) as Promise<MeetingWithAttendees[]>;
}

/**
 * The organizer is disconnecting. "cancel": cancel each invitation (attendees
 * are told). "keep": leave them in Outlook, where Cosmos no longer updates
 * them; their links are kept out of the clean-up so the calendar holding them
 * isn't deleted. Either way invite mode ends and mirrored copies resume.
 */
export async function releaseInvitesOnDisconnect(orgId: string, userId: string, choice: "keep" | "cancel", deps: GraphDeps = {}) {
  for (const m of await liveInvites(orgId, userId)) {
    if (choice === "cancel") {
      await stopInvite(orgId, m, "organizer_disconnected", deps, userId);
    } else {
      await prisma.syncMeeting.update({ where: { id: m.id }, data: { inviteOrganizerId: null } });
      await meetingActivity(orgId, userId, m.id, "outlook_invite_released", null, null, "organizer_disconnected");
      await logAudit({
        orgId, userId, action: "microsoft_calendar.invite_released", entity: "sync_meeting", entityId: m.id,
        metadata: { organizerId: userId, reason: "organizer_disconnected" },
      });
    }
  }
}

/** Tell the org's admins, once per event, that invitations were stopped for someone. */
async function notifyAdmins(orgId: string, organizerId: string, count: number, reason: OffboardReason) {
  const [admins, who, org] = await Promise.all([
    prisma.orgMember.findMany({ where: { orgId, role: { in: ["OWNER", "ADMIN"] } }, select: { userId: true } }),
    prisma.user.findUnique({ where: { id: organizerId }, select: { displayName: true, email: true } }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } }),
  ]);
  const name = who?.displayName || who?.email || "Someone";
  const why = reason === "integration_disabled" ? "Outlook Calendar was turned off" : reason === "tenant_changed" ? "the Microsoft tenant changed" : `${name} no longer has access`;
  for (const a of admins) {
    await createNotification({
      orgId, userId: a.userId, type: "integration.outlook_invites_cancelled",
      title: `Outlook invitations cancelled (${count})`,
      message: `${count} meeting invitation${count === 1 ? "" : "s"} sent from ${name}'s Outlook were cancelled because ${why}.`,
      url: org ? `/${org.slug}/meetings` : null,
    }).catch(() => undefined);
  }
}

/**
 * A connection is being removed because it may no longer exist (they left,
 * were deactivated, the admin turned Outlook Calendar off, the tenant moved):
 * cancel the invitations they send while the token still works, audit it, and
 * tell the admins. Never leaves live invitations nobody in Cosmos can update.
 */
export async function offboardInvites(orgId: string, userId: string, reason: OffboardReason, deps: GraphDeps = {}) {
  const meetings = await liveInvites(orgId, userId);
  if (!meetings.length) return;
  for (const m of meetings) {
    try {
      // No token to cancel with, and the connection (with its links) is going:
      // end invite mode anyway, so nothing pretends to be managed.
      if ((await stopInvite(orgId, m, reason, { ...deps, offboarding: true }, userId)) === "pending") {
        await prisma.syncMeeting.updateMany({ where: { id: m.id, inviteOrganizerId: userId }, data: { inviteOrganizerId: null } });
      }
    } catch (e) {
      // Couldn't reach Microsoft: still end invite mode, so nothing pretends to be managed.
      await prisma.syncMeeting.updateMany({ where: { id: m.id, inviteOrganizerId: userId }, data: { inviteOrganizerId: null } });
      console.error("outlook invite cancel failed:", e instanceof Error ? e.message : "unknown");
    }
  }
  await notifyAdmins(orgId, userId, meetings.length, reason);
}
onCalendarOffboard((orgId, userId, reason, deps) => offboardInvites(orgId, userId, reason, deps));

/** Every organizer in an org, before the admin turns Outlook Calendar off. */
export async function offboardOrgInvites(orgId: string, deps: GraphDeps = {}) {
  const organizers = await prisma.syncMeeting.findMany({
    where: { orgId, inviteOrganizerId: { not: null }, status: { not: "CANCELLED" } },
    select: { inviteOrganizerId: true }, distinct: ["inviteOrganizerId"],
  });
  for (const o of organizers) await offboardInvites(orgId, o.inviteOrganizerId as string, "integration_disabled", deps);
}

/**
 * Create or update one person's copy of a meeting and store the echo
 * changeKey. Skips the write when the body is what we last sent, unless
 * `force` (an Outlook edit we're overwriting changed it on their side).
 * The caller has already checked they may see it.
 */
async function pushFor(
  orgId: string, userId: string, m: SyncMeeting, deps: GraphDeps,
  cls: ClassificationResolver, force = false, invitees?: Invitee[],
): Promise<void> {
  const conn = await calendarConnection(orgId, userId);
  if (!conn) return;
  let calendarId = await ensureCosmosCalendar(orgId, userId, deps);
  const restricted = cls.restricted(m.projectId, m.title, m.meetingUrl);
  // Invite mode (organizer only, never restricted): the attendees go on the
  // event, and Outlook sends the invitations and updates.
  const inviting = !!invitees && !restricted;
  // Their sharing level decides what their own mirrored copy carries. An
  // invitation they chose to send carries the details its attendees need,
  // whatever level they publish their calendar at.
  const busyOnly = restricted || (!inviting && (await sharingLevelFor(orgId, conn.meta)) === "busy");
  const base = meetingEvent(m, busyOnly, await meetingLink(orgId, conn.meta, m.id));
  const body = inviting ? inviteBody(base, invitees!) : base;
  const hash = inviting ? inviteHash(body as ReturnType<typeof inviteBody>) : bodyHash(body);
  let existing = await prisma.externalEventLink.findUnique({ where: linkKey(orgId, userId, m.id) });
  if (existing && !force && existing.contentHash === hash && existing.externalCalendarId === calendarId) return;
  const wasInvite = !!existing?.contentHash?.startsWith(INVITE_PREFIX);
  if (wasInvite && !inviting) {
    // Never turn an invitation into a mirror copy: its attendees would stay on
    // an event nothing manages. Cancel it (scrubbed); a fresh copy follows.
    await cancelInviteEvent(orgId, userId, existing!, deps);
    await prisma.externalEventLink.delete({ where: { id: existing!.id } });
    await logAudit({
      orgId, userId, action: "microsoft_calendar.invite_cancelled", entity: "sync_meeting", entityId: m.id,
      metadata: { organizerId: userId, reason: restricted ? "classified" : "mirror_resumed" },
    });
    existing = null;
  }
  if (inviting) chargeInviteOp(userId); // this write notifies people
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
    const create = (cal: string) =>
      graphRequest<GraphEvent>(
        orgId, userId, "POST", `/me/calendars/${encodeURIComponent(cal)}/events`,
        { ...body, transactionId: `cosmos-${m.id}-${userId}-${m.updatedAt.getTime()}` }, deps,
      );
    try {
      ev = (await create(calendarId)).data;
    } catch (e) {
      if (!(e instanceof GraphError && e.status === 404)) throw e;
      // Our calendar was deleted in Outlook: find or make it again, once.
      await forgetCalendar(orgId, userId);
      calendarId = await ensureCosmosCalendar(orgId, userId, deps);
      ev = (await create(calendarId)).data;
    }
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
  if (inviting) {
    await inviteAudit(orgId, userId, m.id, wasInvite ? "microsoft_calendar.invite_updated" : "microsoft_calendar.invite_sent", invitees!, conn.meta, {
      ...(wasInvite ? { fields: changedInviteParts(existing!.contentHash!, hash).join(", ") } : {}),
    });
  }
}

/**
 * Delete one person's copy. The link is removed only once Outlook has it
 * gone (or never had it); on any other failure it stays, and the reconcile
 * pass in the pull job tries again.
 */
async function removeFor(orgId: string, userId: string, meetingId: string, deps: GraphDeps) {
  const link = await prisma.externalEventLink.findUnique({ where: linkKey(orgId, userId, meetingId) });
  if (!link) return;
  if (link.contentHash?.startsWith(INVITE_PREFIX)) {
    // Their event is a meeting others were invited to: cancel it, so the
    // attendees get a cancellation (a plain delete may not tell them).
    await cancelInviteEvent(orgId, userId, link, deps);
    await prisma.externalEventLink.delete({ where: { id: link.id } });
    await logAudit({
      orgId, userId, action: "microsoft_calendar.invite_cancelled", entity: "sync_meeting", entityId: meetingId,
      metadata: { organizerId: userId, reason: "meeting_gone" },
    });
    return;
  }
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
  // Invite mode: the organizer's event carries the attendees; nobody else
  // gets a mirrored copy (the invitation is their copy). If it can't go on
  // (classified now, organizer can't edit or isn't connected, too many
  // people) it is cancelled and the meeting goes back to mirroring.
  if (m && m.status !== "CANCELLED" && m.inviteOrganizerId) {
    const organizer = m.inviteOrganizerId;
    // A cancellation that couldn't be delivered earlier: try it again first.
    const own = await prisma.externalEventLink.findUnique({ where: linkKey(orgId, organizer, m.id) });
    if (own?.contentHash?.startsWith(PENDING_CANCEL)) {
      const reason = own.contentHash.slice(PENDING_CANCEL.length) as InviteStopReason;
      if ((await stopInvite(orgId, m, reason, deps, organizer)) === "pending") return;
      return syncMeeting(orgId, meetingId, deps, skipUserId);
    }
    const blocked = await inviteBlocker(orgId, m, cls);
    if (blocked === "paused") return; // organizer must reconnect; nothing changes meanwhile
    if (blocked) {
      if ((await stopInvite(orgId, m, blocked, deps, organizer)) === "pending") return;
      return syncMeeting(orgId, meetingId, deps, skipUserId);
    }
    const invitees = await inviteesFor(m);
    const work: (() => Promise<void>)[] = [];
    if (organizer !== skipUserId) work.push(() => pushFor(orgId, organizer, m, deps, cls, false, invitees));
    for (const l of links) if (l.userId !== organizer) work.push(() => removeFor(orgId, l.userId, meetingId, deps));
    await pool(work, CONCURRENCY, (w) => w());
    return;
  }
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

/**
 * Fire-and-forget: rewrite one person's copies, so a sharing level they just
 * changed takes effect now rather than at the next scheduled pull. The
 * reconcile pass re-sends every copy whose body the new level changed.
 */
export function syncUserSoon(orgId: string, userId: string): Promise<void> | undefined {
  const run = () =>
    syncUserNow(orgId, userId).then(
      () => undefined,
      (e: unknown) => {
        if (!personal(e)) console.error("outlook resync failed:", e instanceof Error ? e.message : "unknown");
      },
    );
  try {
    after(run); // keeps the work alive past the response
    return undefined;
  } catch {
    return run(); // outside a request (scripts, tests)
  }
}

/**
 * A classification changed (org-wide, or one project's): re-check live
 * invitations now, so one whose meeting became classified is cancelled at
 * once rather than at the next reconcile. Fire-and-forget, like any push.
 */
export async function syncInvitesAfterClassification(
  orgId: string, projectId: string | null, run: (orgId: string, meetingId: string) => unknown = syncMeetingSoon,
): Promise<number> {
  const meetings = await prisma.syncMeeting.findMany({
    where: { orgId, inviteOrganizerId: { not: null }, status: { not: "CANCELLED" }, ...(projectId ? { projectId } : {}) },
    select: { id: true },
  });
  for (const m of meetings) await run(orgId, m.id);
  return meetings.length;
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
      // Our calendar is gone: forget it; the reconcile pass below makes a new
      // one and re-sends everything into it.
      if (e instanceof GraphError && e.status === 404) {
        await forgetCalendar(orgId, userId);
        await prisma.externalEventLink.deleteMany({ where: { orgId, provider: MS_CALENDAR, userId } });
        await reconcileUser(orgId, userId, deps, cls, viewer);
        return out;
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
  // What their copy carries, by the same rule the push follows: a busy-only
  // copy holds no title of ours, so none can come back from one.
  const conn = await calendarConnection(orgId, userId);
  const level = conn ? await sharingLevelFor(orgId, conn.meta) : DEFAULT_SHARING_LEVEL;
  const busyOnly = restricted || (m.inviteOrganizerId !== userId && level === "busy");
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
  // A busy-only copy's title never left Cosmos, so none can come back.
  const subject = ev.subject?.trim().slice(0, MAX_TITLE);
  if (!busyOnly && subject && subject !== m.title && subject !== RESTRICTED_TITLE) {
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
    out.ignored++;
    if (m.inviteOrganizerId !== userId) {
      await pushFor(orgId, userId, m, deps, cls, true); // put the Cosmos version back
      return;
    }
    // Their copy is the invitation: re-send it (attendees and all) only if it
    // may still go out, as any other send is checked.
    const mw = await withAttendees(m);
    const blocked = await inviteBlocker(orgId, mw, cls);
    if (blocked === "paused") return;
    if (blocked) {
      if ((await stopInvite(orgId, mw, blocked, deps, userId)) === "stopped") await syncMeeting(orgId, m.id, deps);
      return;
    }
    await pushFor(orgId, userId, m, deps, cls, true, await inviteesFor(mw));
    return;
  }
  const updated = await prisma.syncMeeting.update({ where: { id: m.id }, data: changes });
  for (const [field, o, n] of trail) await meetingActivity(orgId, userId, m.id, "outlook_updated", field, o, n);
  // Their copy now matches the meeting: record that, so nothing re-sends it.
  const restrictedNow = cls.restricted(updated.projectId, updated.title, updated.meetingUrl);
  const invitingNow = updated.inviteOrganizerId === userId && !restrictedNow;
  const busyNow = restrictedNow || (!invitingNow && level === "busy");
  const view = conn ? meetingEvent(updated, busyNow, await meetingLink(orgId, conn.meta, m.id)) : null;
  const hash = !view ? null
    : invitingNow ? inviteHash(inviteBody(view, await inviteesFor(await withAttendees(updated))))
    : bodyHash(view);
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
  // Invite mode: the organizer's copy is the invitation, kept and brought up
  // to date through syncMeeting (never removed here: removing would cancel it);
  // everyone else has no copy of it.
  const organizing: string[] = [];
  for (const m of [...attended, ...extra]) {
    if (m.inviteOrganizerId === userId && m.status !== "CANCELLED") {
      keepIds.add(m.id);
      organizing.push(m.id);
    }
  }
  for (const m of [...attended, ...extra.filter((x) => x.status !== "CANCELLED" && x.attendees.some((a) => a.userId === userId))]) {
    if (m.inviteOrganizerId) continue;
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
    ...[...new Set(organizing)].map((id) => () => syncMeeting(orgId, id, deps)),
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
 * Before a person disconnects: clear their copies out of Outlook. The whole
 * calendar is deleted only when it is one we created (tagged, theirs) and no
 * other Cosmos org on the same Microsoft account still uses it; otherwise only
 * this org's events are deleted, so nothing of theirs is ever lost. Best
 * effort; disconnecting goes ahead whatever Microsoft says.
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
    // Only a calendar we created (tagged, theirs) is ever deleted whole.
    let mine = false;
    try {
      const q = new URLSearchParams({ $select: "id,name,canEdit,owner", $expand: `singleValueExtendedProperties($filter=id eq '${COSMOS_CALENDAR_PROP}')` });
      const { data } = await graphRequest<GraphCalendar>(orgId, userId, "GET", `/me/calendars/${encodeURIComponent(conn.meta.calendarId)}?${q}`, undefined, deps);
      mine = ours(data, conn.meta);
    } catch (e) {
      if (!(e instanceof GraphError && e.status === 404)) throw e;
      return true; // already gone
    }
    // Invitations they chose to keep live in this calendar: never delete it
    // then, and never touch those events (deleting one would cancel it).
    const links = await prisma.externalEventLink.findMany({
      where: { orgId, provider: MS_CALENDAR, userId, entityType: ENTITY },
      select: { entityId: true, contentHash: true },
    });
    const kept = links.filter((l) => l.contentHash?.startsWith(INVITE_PREFIX));
    if (shared > 0 || !mine || kept.length) {
      await pool(links.filter((l) => !kept.includes(l)), CONCURRENCY, (l) => removeFor(orgId, userId, l.entityId, deps));
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
