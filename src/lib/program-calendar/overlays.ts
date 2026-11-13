/**
 * The overlays on Program Management's calendar, as data.
 *
 * The calendar draws program events, and on top of them, each switched on or
 * off by the viewer, the records other parts of Cosmos already keep on a date:
 *
 * - EVENTS: program events (the calendar's own rows) and milestones.
 * - AGILE: Program Increments, sprints and releases (Interval rows) and the
 *   due dates of work items.
 *
 * Only DATED records are drawn. PI planning and system demos have no date of
 * their own in Cosmos -- a sprint ceremony belongs to a sprint but has no
 * scheduled day -- so placing them would mean inventing a rule, and that is a
 * product decision, not a rendering one.
 *
 * Pure and browser-safe: the server module that reads the rows
 * (`agile.server.ts`) and the client that draws them both import from here, so
 * the payload has one shape and a date is turned into a calendar span in one
 * place.
 */
import type { ChipCategory } from "@/components/program-calendar/event-chip";
import { DAY_MS, utcMidnight } from "./time";

export type OverlayKey = "events" | "agile";
export const OVERLAY_KEYS: readonly OverlayKey[] = ["events", "agile"];

/** What a chip on the calendar is, when it is not a program event. */
export type OverlayKind = "milestone" | "increment" | "sprint" | "release" | "due";

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
};

export function overlayCategory(kind: OverlayKind): ChipCategory {
  return { id: `overlay:${kind}`, name: KIND_LABEL[kind], ...OVERLAY_STYLES[kind] };
}

/**
 * Lane order when overlays share a week: lower goes first. Program events and
 * milestones are what the calendar is for, so they keep the top lanes; the
 * cadence sits under them, and due dates, which can be many on one day, last.
 * Within a rank the packer still puts the longest bar first.
 */
export const KIND_RANK: Record<OverlayKind | "event", number> = {
  event: 0,
  milestone: 0,
  increment: 1,
  release: 1,
  sprint: 1,
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
  allDay: true;
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

// ── The viewer's toggles ─────────────────────────────────────────────────────

export type OverlayToggles = Record<OverlayKey, boolean>;

/** A first visit shows the calendar's own events, and nothing on top. */
export const DEFAULT_TOGGLES: OverlayToggles = { events: true, agile: false };

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
