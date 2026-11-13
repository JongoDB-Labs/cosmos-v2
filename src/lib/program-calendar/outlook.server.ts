import { graphRequest, GraphError, GraphThrottled, type GraphDeps } from "@/lib/integrations/microsoft/graph.server";
import {
  calendarConnection,
  CalendarNotConnected,
  CalendarReconnectNeeded,
  orgCalendarConfig,
} from "@/lib/integrations/microsoft/calendar-token.server";
import { DAY_MS } from "./time";
import {
  OUTLOOK_MAX_PAGES,
  OUTLOOK_PAGE_SIZE,
  type OutlookEvent,
  type OutlookPayload,
  type OutlookStatus,
} from "./overlays";

/**
 * The Outlook overlay: the viewer's OWN main calendar, read through their OWN
 * Outlook Calendar connection.
 *
 * There is no way to name anyone else. Both functions take the user id the
 * route already resolved from the session, and the Graph token is that
 * person's, for `/me/...`: Microsoft answers for the mailbox the token belongs
 * to and nothing else. No new permission is asked for: the connection already
 * holds `Calendars.ReadWrite`, and this only reads.
 *
 * Nothing read here is stored. The events go to the viewer's browser and
 * nowhere else; no other person, API key or Cosmos page sees them.
 */

/**
 * Where the viewer's Outlook stands, without calling Microsoft: enough for the
 * page to say "connect" or "reconnect" before anyone turns the overlay on.
 */
export async function outlookOverlayStatus(orgId: string, userId: string): Promise<OutlookStatus> {
  const [cfg, conn] = await Promise.all([orgCalendarConfig(orgId), calendarConnection(orgId, userId)]);
  if (!cfg) return "off";
  if (!conn) return "not_connected";
  return conn.meta.status === "reconnect" ? "reconnect" : "connected";
}

interface GraphDateTime {
  dateTime: string;
  timeZone?: string;
}
interface GraphEvent {
  id: string;
  subject?: string | null;
  start?: GraphDateTime;
  end?: GraphDateTime;
  isAllDay?: boolean;
  isCancelled?: boolean;
  webLink?: string | null;
}
interface GraphPage {
  value?: GraphEvent[];
  "@odata.nextLink"?: string;
}

const SELECT = "id,subject,start,end,isAllDay,isCancelled,webLink";

/**
 * The viewer's main-calendar events overlapping [from, to).
 *
 * `/me/calendarView` is the right read for a window: it returns each
 * occurrence of a recurring series as its own instance, which `/me/events`
 * does not. Up to OUTLOOK_MAX_PAGES pages of OUTLOOK_PAGE_SIZE; past that,
 * `capped` says so rather than the overlay quietly stopping.
 */
export async function loadOutlookOverlay(
  orgId: string,
  userId: string,
  window: { from: Date; to: Date },
  deps: GraphDeps = {},
): Promise<OutlookPayload> {
  const status = await outlookOverlayStatus(orgId, userId);
  if (status !== "connected") return { status, events: [], capped: false };

  const query = new URLSearchParams({
    startDateTime: window.from.toISOString(),
    endDateTime: window.to.toISOString(),
    $select: SELECT,
    $orderby: "start/dateTime",
    $top: String(OUTLOOK_PAGE_SIZE),
  });
  let next: string | undefined = `/me/calendarView?${query}`;
  const events: OutlookEvent[] = [];
  try {
    for (let page = 0; next && page < OUTLOOK_MAX_PAGES; page++) {
      const { data }: { data: GraphPage | null } = await graphRequest<GraphPage>(orgId, userId, "GET", next, undefined, deps);
      for (const e of data?.value ?? []) {
        const mapped = toOverlayEvent(e);
        if (mapped) events.push(mapped);
      }
      next = data?.["@odata.nextLink"];
    }
  } catch (e) {
    // The connection can go between the status read and the token: say so.
    if (e instanceof CalendarNotConnected) return { status: "not_connected", events: [], capped: false };
    if (e instanceof CalendarReconnectNeeded) return { status: "reconnect", events: [], capped: false };
    if (e instanceof GraphThrottled) {
      return {
        status: "unavailable", events: [], capped: false,
        detail: "Microsoft is limiting requests from your account right now. Try again in a minute.",
      };
    }
    if (e instanceof GraphError) {
      // The status and Graph's error code only: never a body or a token.
      console.warn("outlook overlay read failed:", e.message);
      return {
        status: "unavailable", events: [], capped: false,
        detail: `Microsoft did not return your calendar (${e.status || "no answer"}${e.code ? `, ${e.code}` : ""}).`,
      };
    }
    throw e;
  }
  return { status: "connected", events, capped: Boolean(next) };
}

/**
 * One Graph event as the overlay draws it, or null for one it should not draw:
 * a cancelled meeting, or one whose times are unreadable.
 *
 * Times: every Graph call here sends `Prefer: outlook.timezone="UTC"`, so
 * `dateTime` is a UTC wall time with no offset, read as UTC. An all-day event
 * is a run of whole dates, which Graph gives as midnights: kept as those dates
 * (see `dateOf`), never shifted by a zone.
 */
export function toOverlayEvent(e: GraphEvent): OutlookEvent | null {
  if (e.isCancelled) return null;
  if (!e.start?.dateTime || !e.end?.dateTime) return null;
  const allDay = e.isAllDay === true;
  const start = allDay ? dateOf(e.start.dateTime) : utcInstant(e.start.dateTime);
  let end = allDay ? dateOf(e.end.dateTime) : utcInstant(e.end.dateTime);
  if (start === null || end === null) return null;
  // An all-day event always covers at least its own day.
  if (allDay && end <= start) end = start + DAY_MS;
  if (end < start) return null;
  return {
    id: e.id,
    subject: e.subject?.trim() || "(No title)",
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    allDay,
    webLink: httpsOnly(e.webLink),
  };
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?(Z|[+-]\d{2}:\d{2})?$/;

/** Graph's `dateTime` (seven fractional digits, normally no offset) as epoch ms. */
function utcInstant(s: string): number | null {
  const m = WALL.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, frac, zone] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(sec ?? 0), frac ? Math.floor(+`0.${frac}` * 1000) : 0);
  if (!zone || zone === "Z") return ms;
  const sign = zone[0] === "-" ? -1 : 1;
  const [zh, zm] = zone.slice(1).split(":").map(Number);
  return ms - sign * (zh * 60 + zm) * 60_000;
}

/**
 * An all-day boundary as UTC midnight of its date.
 *
 * Graph gives an all-day event's start and end as midnights. If one ever comes
 * back moved onto another zone's clock (say 05:00 for a US mailbox), the
 * nearest midnight is the date it meant: no zone sits more than twelve hours
 * from UTC on the side that would round the wrong way, except a few Pacific
 * islands at +13 and +14.
 */
function dateOf(s: string): number | null {
  const ms = utcInstant(s);
  if (ms === null) return null;
  return Math.round(ms / DAY_MS) * DAY_MS;
}

function httpsOnly(link: string | null | undefined): string | null {
  if (!link) return null;
  try {
    return new URL(link).protocol === "https:" ? link : null;
  } catch {
    return null;
  }
}
