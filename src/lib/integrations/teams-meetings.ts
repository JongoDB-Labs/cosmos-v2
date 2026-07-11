/**
 * Microsoft Teams meetings — schedule / list / invite-remove / cancel / delete
 * Teams meetings on the org's linked M365 tenant (COSMOS-48).
 *
 * Built on the org's `microsoft365` sealed Entra app credential (the "linked M365
 * tenant" from the Integrations page): every operation is app-only Microsoft Graph
 * against the org's OWN tenant via {@link graphFetch}/{@link graphWrite}, so it is
 * TENANT-SCOPED by construction — an org can only see or mutate events on the tenant
 * whose sealed credential it holds; there is no cross-tenant path.
 *
 * A Teams meeting is modelled as a calendar event with
 * `isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness"` on an ORGANIZER
 * mailbox. That is what makes it appear on the M365 calendar with attendees, a Teams
 * join URL, and native cancel/delete semantics — mapping the ticket's
 * schedule/invite/cancel/delete verbs straight onto Graph's `/users/{id}/events`.
 * App-only Graph has no signed-in user, so the caller must name the organizer mailbox
 * (a user id or UPN on the linked tenant).
 *
 * INVARIANTS:
 *   - No secret/token ever leaves this layer — `graphFetch`/`graphWrite` own token
 *     hygiene and only ever return the Graph payload or a code-only error string.
 *   - A missing credential ("not connected") or an insufficient-permission Graph 403
 *     is a GRACEFUL, message-carrying `{ ok:false, error }` — never a throw.
 *   - `fetch` is injectable (`opts.fetchImpl`) so tests exercise the full flow with
 *     no network.
 */

import { graphFetch, graphWrite, type FetchLike } from "./microsoft-graph";

export type AttendeeType = "required" | "optional";

/** An attendee to invite. `type` defaults to "required". */
export interface MeetingAttendeeInput {
  email: string;
  name?: string;
  type?: AttendeeType;
}

/** Input for {@link scheduleTeamsMeeting}. */
export interface ScheduleMeetingInput {
  /** The organizer mailbox on the linked tenant — a user id (GUID) or UPN. */
  organizer: string;
  subject: string;
  /**
   * Start/end wall-clock date-times interpreted in `timeZone` (default "UTC"),
   * e.g. "2026-07-15T10:00:00". A trailing "Z"/offset is tolerated by Graph but the
   * `timeZone` field is authoritative.
   */
  start: string;
  end: string;
  /** IANA/Windows time-zone name for `start`/`end`. Defaults to "UTC". */
  timeZone?: string;
  /** Optional HTML meeting body/description. */
  bodyHtml?: string;
  /** Attendees to invite. Omit for a meeting with no invitees. */
  attendees?: MeetingAttendeeInput[];
}

/** A normalized Teams meeting as surfaced to the platform (no secret/token). */
export interface TeamsMeeting {
  id: string;
  subject: string;
  start: string | null;
  end: string | null;
  timeZone: string | null;
  joinUrl: string | null;
  webLink: string | null;
  isCancelled: boolean;
  attendees: {
    email: string;
    name: string | null;
    type: string | null;
    response: string | null;
  }[];
}

export type MeetingResult = { ok: true; meeting: TeamsMeeting } | { ok: false; error: string };
export type MeetingListResult =
  | { ok: true; meetings: TeamsMeeting[] }
  | { ok: false; error: string };
export type MutationResult = { ok: true } | { ok: false; error: string };

type Opts = { fetchImpl?: FetchLike };

const ORGANIZER_REQUIRED =
  "An organizer (Microsoft 365 user id or UPN on the linked tenant) is required.";
const EVENT_ID_REQUIRED = "A meeting id is required.";

/** Map a raw Graph event object to a normalized {@link TeamsMeeting}. */
function mapEvent(ev: Record<string, unknown>): TeamsMeeting {
  const onlineMeeting = (ev.onlineMeeting ?? {}) as Record<string, unknown>;
  const start = (ev.start ?? {}) as Record<string, unknown>;
  const end = (ev.end ?? {}) as Record<string, unknown>;
  const attendees = Array.isArray(ev.attendees) ? ev.attendees : [];
  return {
    id: typeof ev.id === "string" ? ev.id : "",
    subject: typeof ev.subject === "string" ? ev.subject : "",
    start: typeof start.dateTime === "string" ? start.dateTime : null,
    end: typeof end.dateTime === "string" ? end.dateTime : null,
    timeZone: typeof start.timeZone === "string" ? start.timeZone : null,
    joinUrl: typeof onlineMeeting.joinUrl === "string" ? onlineMeeting.joinUrl : null,
    webLink: typeof ev.webLink === "string" ? ev.webLink : null,
    isCancelled: ev.isCancelled === true,
    attendees: attendees.map((a) => {
      const at = (a ?? {}) as Record<string, unknown>;
      const ea = (at.emailAddress ?? {}) as Record<string, unknown>;
      const status = (at.status ?? {}) as Record<string, unknown>;
      return {
        email: typeof ea.address === "string" ? ea.address : "",
        name: typeof ea.name === "string" ? ea.name : null,
        type: typeof at.type === "string" ? at.type : null,
        response: typeof status.response === "string" ? status.response : null,
      };
    }),
  };
}

/** Build the Graph `attendees` array from the platform's attendee inputs. */
function toGraphAttendees(attendees: MeetingAttendeeInput[]) {
  return attendees.map((a) => ({
    emailAddress: {
      address: a.email,
      ...(a.name ? { name: a.name } : {}),
    },
    type: a.type === "optional" ? "optional" : "required",
  }));
}

/**
 * Schedule a new Teams meeting on the linked tenant — POSTs a calendar event with a
 * Teams online meeting to the organizer's mailbox. On success the event appears on
 * the organizer's M365 calendar and each attendee receives the invite. Returns the
 * created meeting (id + join URL) or a graceful error.
 */
export async function scheduleTeamsMeeting(
  orgId: string,
  input: ScheduleMeetingInput,
  opts: Opts = {},
): Promise<MeetingResult> {
  const organizer = input.organizer?.trim();
  if (!organizer) return { ok: false, error: ORGANIZER_REQUIRED };
  if (!input.subject?.trim()) return { ok: false, error: "A meeting subject is required." };
  if (!input.start || !input.end) {
    return { ok: false, error: "A start and end time are required." };
  }
  const startMs = Date.parse(input.start);
  const endMs = Date.parse(input.end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return { ok: false, error: "Start and end must be valid date-times." };
  }
  if (endMs <= startMs) {
    return { ok: false, error: "The meeting end time must be after the start time." };
  }

  const timeZone = input.timeZone?.trim() || "UTC";
  const body: Record<string, unknown> = {
    subject: input.subject,
    start: { dateTime: input.start, timeZone },
    end: { dateTime: input.end, timeZone },
    isOnlineMeeting: true,
    onlineMeetingProvider: "teamsForBusiness",
  };
  if (input.bodyHtml) body.body = { contentType: "HTML", content: input.bodyHtml };
  if (input.attendees && input.attendees.length > 0) {
    body.attendees = toGraphAttendees(input.attendees);
  }

  const res = await graphWrite(
    orgId,
    "POST",
    `/users/${encodeURIComponent(organizer)}/events`,
    body,
    opts,
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, meeting: mapEvent((res.data ?? {}) as Record<string, unknown>) };
}

/**
 * List the organizer's upcoming Teams meetings on the linked tenant (online events
 * only, newest first). Returns the meetings or a graceful error.
 */
export async function listTeamsMeetings(
  orgId: string,
  args: { organizer: string; top?: number },
  opts: Opts = {},
): Promise<MeetingListResult> {
  const organizer = args.organizer?.trim();
  if (!organizer) return { ok: false, error: ORGANIZER_REQUIRED };
  const top = args.top && args.top > 0 ? Math.min(Math.floor(args.top), 100) : 50;
  const select =
    "id,subject,start,end,isOnlineMeeting,onlineMeeting,webLink,isCancelled,attendees";
  const path = `/users/${encodeURIComponent(organizer)}/events?$select=${select}&$top=${top}`;

  const res = await graphFetch(orgId, path, opts);
  if (!res.ok) return { ok: false, error: res.error };
  const value = (res.data as { value?: unknown })?.value;
  const rows = Array.isArray(value) ? value : [];
  const meetings = rows
    .map((v) => (v ?? {}) as Record<string, unknown>)
    .filter((v) => v.isOnlineMeeting === true)
    .map(mapEvent)
    .sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""));
  return { ok: true, meetings };
}

/**
 * Replace a meeting's attendee list — the invite/remove primitive. Pass the FULL
 * desired attendee set: attendees not in the list are removed, new ones are invited.
 * Graph re-sends the invite to added attendees and a cancellation to removed ones.
 * Returns the updated meeting or a graceful error.
 */
export async function updateTeamsMeetingAttendees(
  orgId: string,
  args: { organizer: string; eventId: string; attendees: MeetingAttendeeInput[] },
  opts: Opts = {},
): Promise<MeetingResult> {
  const organizer = args.organizer?.trim();
  const eventId = args.eventId?.trim();
  if (!organizer) return { ok: false, error: ORGANIZER_REQUIRED };
  if (!eventId) return { ok: false, error: EVENT_ID_REQUIRED };
  if (!Array.isArray(args.attendees)) {
    return {
      ok: false,
      error:
        "An attendees list is required — pass the full desired attendee set (omit an attendee to remove them).",
    };
  }

  const res = await graphWrite(
    orgId,
    "PATCH",
    `/users/${encodeURIComponent(organizer)}/events/${encodeURIComponent(eventId)}`,
    { attendees: toGraphAttendees(args.attendees) },
    opts,
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, meeting: mapEvent((res.data ?? {}) as Record<string, unknown>) };
}

/**
 * Cancel a meeting — Graph's `/cancel` action marks the event cancelled on the
 * organizer's calendar and sends a cancellation message (with the optional comment)
 * to every attendee. Only the organizer mailbox can cancel. Returns ok or a graceful
 * error. (Cancelling keeps the event on the calendar as cancelled; use
 * {@link deleteTeamsMeeting} to remove it entirely.)
 */
export async function cancelTeamsMeeting(
  orgId: string,
  args: { organizer: string; eventId: string; comment?: string },
  opts: Opts = {},
): Promise<MutationResult> {
  const organizer = args.organizer?.trim();
  const eventId = args.eventId?.trim();
  if (!organizer) return { ok: false, error: ORGANIZER_REQUIRED };
  if (!eventId) return { ok: false, error: EVENT_ID_REQUIRED };

  const res = await graphWrite(
    orgId,
    "POST",
    `/users/${encodeURIComponent(organizer)}/events/${encodeURIComponent(eventId)}/cancel`,
    { comment: args.comment ?? "" },
    opts,
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}

/**
 * Delete a meeting — removes the event from the organizer's calendar entirely.
 * Graph answers 204 No Content. Returns ok or a graceful error.
 */
export async function deleteTeamsMeeting(
  orgId: string,
  args: { organizer: string; eventId: string },
  opts: Opts = {},
): Promise<MutationResult> {
  const organizer = args.organizer?.trim();
  const eventId = args.eventId?.trim();
  if (!organizer) return { ok: false, error: ORGANIZER_REQUIRED };
  if (!eventId) return { ok: false, error: EVENT_ID_REQUIRED };

  const res = await graphWrite(
    orgId,
    "DELETE",
    `/users/${encodeURIComponent(organizer)}/events/${encodeURIComponent(eventId)}`,
    undefined,
    opts,
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}
