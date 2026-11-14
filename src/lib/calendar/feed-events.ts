import { entityUrl } from "@/lib/mentions/urls";
import type { IcsEvent } from "./ics";

/**
 * COSMOS-202: what a person's calendar feed shows. Their dated work, the
 * meetings they attend, and the sprints/PIs of their projects, each mapped to
 * the event a calendar app expects. Pure, so the route only has to fetch.
 */

export interface FeedOptions {
  workItems: boolean;
  meetings: boolean;
  intervals: boolean;
  /** "Busy" with no title, description or link: for calendars shared with others. */
  busyOnly: boolean;
}

export const DEFAULT_FEED_OPTIONS: FeedOptions = {
  workItems: true,
  meetings: true,
  intervals: false,
  busyOnly: false,
};

/**
 * Every source row says whether it is RESTRICTED: in a project whose
 * classification ceiling carries a marking, or with a marking in its own text.
 * A restricted row is always written busy-only, whatever the person chose,
 * because a subscribed feed is fetched by the calendar provider's servers and
 * everything in it leaves this system.
 */
interface Restrictable {
  restricted: boolean;
}

export interface FeedWorkItem extends Restrictable {
  id: string;
  ticketNumber: number;
  projectKey: string;
  title: string;
  startDate: Date | null;
  dueDate: Date | null;
  updatedAt: Date;
}

export interface FeedMeeting extends Restrictable {
  id: string;
  title: string;
  meetingDate: Date;
  updatedAt: Date;
  /** Its Teams join link while it is a Teams meeting (it has a host), else null. */
  teamsJoinUrl: string | null;
  /** The video link someone set on it (any provider), else null. */
  meetingUrl: string | null;
}

/** A meeting's join lines, one per link it has, or null when it has none. */
function joinLines(m: FeedMeeting): string | null {
  const lines = [
    m.meetingUrl ? `Join: ${m.meetingUrl}` : null,
    m.teamsJoinUrl ? `Join the Teams meeting: ${m.teamsJoinUrl}` : null,
  ].filter((l): l is string => l !== null);
  return lines.length > 0 ? lines.join("\n") : null;
}

export interface FeedInterval extends Restrictable {
  id: string;
  name: string;
  projectKey: string;
  startDate: Date;
  endDate: Date;
  /** Null: the row records no change time (an Interval has none). */
  updatedAt: Date | null;
}

/** Meetings carry a start time only; a calendar needs an end. */
export const MEETING_MINUTES = 30;

/** All a busy-only event says. */
export const BUSY = "Busy";

const DAY = 86_400_000;
/** Midnight UTC of the date's calendar day: the app stores date-only values in UTC. */
const dayOf = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export function feedEvents(args: {
  options: FeedOptions;
  workItems: FeedWorkItem[];
  meetings: FeedMeeting[];
  intervals: FeedInterval[];
  /** Absolute origin for links, e.g. https://example.com (from getPublicOrigin). */
  origin: string;
  orgSlug: string;
  /** Domain part of each UID, so UIDs are unique across installs. */
  uidHost: string;
}): IcsEvent[] {
  const { options: o, origin, orgSlug, uidHost } = args;
  const hide = (r: Restrictable) => o.busyOnly || r.restricted;
  const link = (r: Restrictable, path: string | null) => (path && !hide(r) ? `${origin}${path}` : null);
  const label = (r: Restrictable, text: string) => (hide(r) ? BUSY : text);
  const out: IcsEvent[] = [];

  if (o.workItems) {
    for (const w of args.workItems) {
      const first = w.startDate ?? w.dueDate;
      const last = w.dueDate ?? w.startDate;
      if (!first || !last) continue; // undated work has no place on a calendar
      const ref = `${w.projectKey}-${w.ticketNumber}`;
      const start = dayOf(first);
      // DTEND is exclusive; a start after the due date collapses to one day.
      const end = new Date(Math.max(dayOf(last).getTime(), start.getTime()) + DAY);
      out.push({
        uid: `workitem-${w.id}@${uidHost}`,
        summary: label(w, `${ref} ${w.title}`),
        url: link(w, entityUrl("workItem", { orgSlug, id: ref })),
        start,
        end,
        allDay: true,
        lastModified: w.updatedAt,
      });
    }
  }

  if (o.meetings) {
    for (const m of args.meetings) {
      out.push({
        uid: `meeting-${m.id}@${uidHost}`,
        summary: label(m, m.title),
        // The join links go in the description, as the Outlook sync writes
        // them (the video link, then the Teams one): Google, Outlook and Apple
        // Calendar all show a description and make a link in it clickable,
        // while Google ignores URL (which is the meeting's page here) and
        // treats LOCATION as a place. Never on a busy row.
        description: hide(m) ? null : joinLines(m),
        url: link(m, entityUrl("meeting", { orgSlug, id: m.id })),
        start: m.meetingDate,
        end: new Date(m.meetingDate.getTime() + MEETING_MINUTES * 60_000),
        allDay: false,
        lastModified: m.updatedAt,
      });
    }
  }

  if (o.intervals) {
    for (const i of args.intervals) {
      const start = dayOf(i.startDate);
      out.push({
        uid: `interval-${i.id}@${uidHost}`,
        summary: label(i, `${i.projectKey}: ${i.name}`),
        start,
        end: new Date(Math.max(dayOf(i.endDate).getTime(), start.getTime()) + DAY),
        allDay: true,
        lastModified: i.updatedAt,
      });
    }
  }

  return out;
}
