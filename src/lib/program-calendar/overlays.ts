/**
 * The overlays on Program Management's calendar, as data.
 *
 * The calendar draws program events, and on top of them, each switched on or
 * off by the viewer, the records other parts of Cosmos already keep on a date:
 *
 * - EVENTS: program events (the calendar's own rows) and milestones.
 * - AGILE: Program Increments, sprints and releases (Interval rows) and the
 *   due dates of work items.
 * - OUTLOOK: the viewer's own main Outlook calendar, read through their own
 *   Outlook Calendar connection. Only ever theirs, and only shown to them.
 *
 * Only DATED records are drawn. PI planning and system demos have no date of
 * their own in Cosmos -- a sprint ceremony belongs to a sprint but has no
 * scheduled day -- so placing them would mean inventing a rule, and that is a
 * product decision, not a rendering one.
 *
 * Pure and browser-safe: the server modules that read the rows
 * (`agile.server.ts`, `outlook.server.ts`) and the client that draws them all
 * import from here, so
 * the payload has one shape and a date is turned into a calendar span in one
 * place.
 */
import type { ChipCategory } from "@/components/program-calendar/event-chip";
import { DAY_MS, utcMidnight } from "./time";

export type OverlayKey = "events" | "agile" | "outlook";
export const OVERLAY_KEYS: readonly OverlayKey[] = ["events", "agile", "outlook"];

/** What a chip on the calendar is, when it is not a program event. */
export type OverlayKind = "milestone" | "increment" | "sprint" | "release" | "due" | "outlook";

/** The interval kinds the Agile overlay draws, and the chip kind for each. */
export const AGILE_INTERVAL_KINDS = {
  PROGRAM_INCREMENT: "increment",
  SPRINT: "sprint",
  RELEASE: "release",
} as const satisfies Record<string, OverlayKind>;
export type AgileIntervalKind = keyof typeof AGILE_INTERVAL_KINDS;

/** What a screen reader says before the chip's title, and the legend's words. */
export const KIND_LABEL: Record<OverlayKind, string> = {
  milestone: "Milestone",
  increment: "Program increment",
  sprint: "Sprint",
  release: "Release",
  due: "Due",
  outlook: "Outlook",
};

/**
 * Chip colours, in the same form as an event category (an rgb triple plus an
 * alpha, and the light-mode ink) so they composite over either theme exactly as
 * a category does. Each one is held to AA on today's tinted column by
 * `categories.contrast.test.ts`, the same test the default categories pass.
 *
 * Colour is never the only signal: every overlay chip also carries an icon and
 * a spoken kind ("Sprint: ..."), so two kinds that look alike to someone are
 * still told apart.
 */
export const OVERLAY_STYLES: Record<OverlayKind, Omit<ChipCategory, "id" | "name">> = {
  // The default "Milestones" category's colours, so a milestone reads the same
  // whether it came from the register or was entered as an event.
  milestone: { tintRgb: "167 139 250", tintAlpha: 0.24, textColor: "#6D28D9" },
  increment: { tintRgb: "99 102 241", tintAlpha: 0.2, textColor: "#3730A3" },
  sprint: { tintRgb: "14 165 233", tintAlpha: 0.18, textColor: "#075985" },
  release: { tintRgb: "132 204 22", tintAlpha: 0.24, textColor: "#3F6212" },
  due: { tintRgb: "217 70 239", tintAlpha: 0.16, textColor: "#86198F" },
  outlook: { tintRgb: "20 184 166", tintAlpha: 0.2, textColor: "#115E59" },
};

export function overlayCategory(kind: OverlayKind): ChipCategory {
  return { id: `overlay:${kind}`, name: KIND_LABEL[kind], ...OVERLAY_STYLES[kind] };
}

/**
 * Lane order when overlays share a week: lower goes first. Program events and
 * milestones are what the calendar is for, so they keep the top lanes; the
 * cadence sits under them, then the viewer's own meetings, and due dates, which
 * can be many on one day, last.
 * Within a rank the packer still puts the longest bar first.
 */
export const KIND_RANK: Record<OverlayKind | "event", number> = {
  event: 0,
  milestone: 0,
  increment: 1,
  release: 1,
  sprint: 1,
  outlook: 2,
  due: 3,
};

// ── The Agile overlay's payload ──────────────────────────────────────────────

export interface AgileInterval {
  id: string;
  name: string;
  kind: AgileIntervalKind;
  /** ISO instant of the first day (stored as that day's UTC midnight). */
  startDate: string;
  /** ISO instant of the LAST day, inclusive -- an interval's end date is the
   *  day it ends on, as the sprint form shows it. */
  endDate: string;
  projectKey: string;
  projectName: string;
}

export interface AgileDue {
  id: string;
  /** The ticket key, e.g. "WEB-12". */
  key: string;
  title: string;
  /** ISO instant of the due day. */
  dueDate: string;
  /** Done or cancelled, by the same rule the boards strike an item through. */
  resolved: boolean;
}

export interface AgilePayload {
  intervals: AgileInterval[];
  due: AgileDue[];
  /** More work items fall due in the window than were returned. */
  dueCapped: boolean;
}

/** At most this many due work items are returned for one window. */
export const DUE_CAP = 500;

/** The longest window the overlay endpoint answers for, in days. */
export const MAX_WINDOW_DAYS = 400;

// ── Turning records into calendar items ──────────────────────────────────────

/** A record drawn on the calendar. Program events are mapped to the same shape
 *  in the component; the optional fields are what an overlay adds. */
export interface OverlayItem {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  /** Always "UTC": overlay times are already on the grid's clock (see
   *  `wallClock`), so nothing converts them again. */
  timeZone: "UTC";
  category: ChipCategory;
  kind: OverlayKind;
  rank: number;
  /** The record's own page: overlay chips are links, never edited here. */
  href?: string;
  /** The full description, for the tooltip and the accessible name. */
  description: string;
}

/**
 * A DATE as a one-or-more-day calendar span: UTC midnight of the first day to
 * UTC midnight AFTER the last. The same half-open convention an all-day program
 * event is stored in, so the grid's packing and day tests apply unchanged.
 */
export function daySpan(first: Date, lastInclusive: Date): { startsAt: Date; endsAt: Date } {
  const startsAt = utcMidnight(first);
  const last = utcMidnight(lastInclusive);
  const endsAt = new Date(Math.max(last.getTime(), startsAt.getTime()) + DAY_MS);
  return { startsAt, endsAt };
}

function item(
  kind: OverlayKind,
  id: string,
  title: string,
  first: Date,
  last: Date,
  description: string,
  href?: string,
): OverlayItem {
  return {
    id: `${kind}:${id}`,
    title,
    ...daySpan(first, last),
    allDay: true,
    timeZone: "UTC",
    category: overlayCategory(kind),
    kind,
    rank: KIND_RANK[kind],
    href,
    description,
  };
}

const enc = encodeURIComponent;

export function agileItems(p: AgilePayload, orgSlug: string): OverlayItem[] {
  const intervals = p.intervals.map((i) => {
    const kind = AGILE_INTERVAL_KINDS[i.kind];
    return item(
      kind,
      i.id,
      i.name,
      new Date(i.startDate),
      new Date(i.endDate),
      `${KIND_LABEL[kind]}: ${i.name} (${i.projectName})`,
      `/${enc(orgSlug)}/projects/${enc(i.projectKey)}/intervals`,
    );
  });
  const due = p.due.map((d) => {
    const day = new Date(d.dueDate);
    const title = `${d.key} ${d.title}`;
    return item(
      "due",
      d.id,
      title,
      day,
      day,
      `Due: ${title}${d.resolved ? " (done)" : ""}`,
      `/${enc(orgSlug)}/work-items?item=${enc(d.id)}`,
    );
  });
  return [...intervals, ...due];
}

export interface CalendarMilestone {
  id: string;
  title: string;
  /** ISO instant of the due day. */
  dueDate: string;
  projectKey: string;
}

export function milestoneItems(milestones: CalendarMilestone[], orgSlug: string): OverlayItem[] {
  return milestones.map((m) => {
    const day = new Date(m.dueDate);
    return item(
      "milestone",
      m.id,
      m.title,
      day,
      day,
      `Milestone: ${m.title}`,
      `/${enc(orgSlug)}/projects/${enc(m.projectKey)}/milestones`,
    );
  });
}

// ── The Outlook overlay ──────────────────────────────────────────────────────

/**
 * Where the viewer's Outlook stands, for this overlay.
 *
 * - `off`: the organization has not turned on Outlook Calendar, so nobody in
 *   it can connect. An admin turns it on under Settings, Integrations.
 * - `not_connected`: the organization has, and this viewer has not connected.
 * - `reconnect`: they had, and Microsoft stopped accepting the connection.
 * - `connected`: their events are in `events`.
 * - `unavailable`: connected, but Microsoft did not answer usefully this time
 *   (it was limiting requests, or refused); `detail` says which.
 */
export type OutlookStatus = "off" | "not_connected" | "reconnect" | "connected" | "unavailable";

export interface OutlookEvent {
  id: string;
  subject: string;
  /** ISO instant. For an all-day event, UTC midnight of its first day. */
  start: string;
  /** ISO instant, exclusive. For an all-day event, UTC midnight after its last day. */
  end: string;
  allDay: boolean;
  /** The event in Outlook on the web: https only, or null. */
  webLink: string | null;
}

export interface OutlookPayload {
  status: OutlookStatus;
  events: OutlookEvent[];
  /** More events fall in the window than were read. */
  capped: boolean;
  /** Why the status is `unavailable`, in words. */
  detail?: string;
}

/** The longest window the Outlook endpoint answers for, in days: a month view
 *  asks for six weeks, plus a day either side (see the calendar). */
export const OUTLOOK_MAX_WINDOW_DAYS = 62;
/** Events per Graph page, and pages read, for one window. */
export const OUTLOOK_PAGE_SIZE = 100;
export const OUTLOOK_MAX_PAGES = 5;

/**
 * An instant as its wall-clock reading in `timeZone`, expressed as that same
 * reading in UTC.
 *
 * The grid lays days out as UTC dates and reads a chip's time on the chip's
 * own clock. A meeting at 17:00 in Los Angeles is 01:00 UTC the NEXT day, so
 * drawn as an instant it would land in the wrong column for the person whose
 * meeting it is. Their own calendar should read as their own clock does, so
 * the instant is moved onto it once, here, and then drawn as UTC.
 */
export function wallClock(instant: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const n = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return new Date(Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")));
}

const hhmm = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(d);

/**
 * The viewer's Outlook events as calendar items, on the viewer's clock.
 * All-day events are dates already and are not moved.
 */
export function outlookItems(p: OutlookPayload, timeZone: string): OverlayItem[] {
  return p.events.map((e) => {
    const startsAt = e.allDay ? new Date(e.start) : wallClock(new Date(e.start), timeZone);
    const endsAt = e.allDay ? new Date(e.end) : wallClock(new Date(e.end), timeZone);
    const when = e.allDay ? "all day" : `${hhmm(startsAt)} to ${hhmm(endsAt)}`;
    return {
      id: `outlook:${e.id}`,
      title: e.subject,
      startsAt,
      endsAt,
      allDay: e.allDay,
      timeZone: "UTC",
      category: overlayCategory("outlook"),
      kind: "outlook",
      rank: KIND_RANK.outlook,
      href: e.webLink ?? undefined,
      description: `Outlook: ${e.subject}, ${when}`,
    };
  });
}

// ── The viewer's toggles ─────────────────────────────────────────────────────

export type OverlayToggles = Record<OverlayKey, boolean>;

/** A first visit shows the calendar's own events, and nothing on top. */
export const DEFAULT_TOGGLES: OverlayToggles = { events: true, agile: false, outlook: false };

/**
 * The stored toggles, read defensively. The value lives in the viewer's
 * browser storage, which anything on the origin can write and an older build
 * may have written in another shape, so only known keys with boolean values are
 * taken and everything else falls back to the default.
 */
export function parseToggles(raw: string | null | undefined): OverlayToggles {
  const out = { ...DEFAULT_TOGGLES };
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const key of OVERLAY_KEYS) {
    const v = (parsed as Record<string, unknown>)[key];
    if (typeof v === "boolean") out[key] = v;
  }
  return out;
}

/** Where a viewer's toggles are kept: per organization AND per person, so two
 *  people sharing a browser profile do not inherit each other's choices. */
export function togglesStorageKey(orgId: string, userId: string): string {
  return `cosmos:pm-calendar-overlays:${orgId}:${userId}`;
}
