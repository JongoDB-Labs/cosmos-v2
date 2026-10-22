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

export interface FeedWorkItem {
  id: string;
  ticketNumber: number;
  projectKey: string;
  title: string;
  startDate: Date | null;
  dueDate: Date | null;
  updatedAt: Date;
}

export interface FeedMeeting {
  id: string;
  title: string;
  meetingDate: Date;
  updatedAt: Date;
}

export interface FeedInterval {
  id: string;
  name: string;
  projectKey: string;
  startDate: Date;
  endDate: Date;
  updatedAt: Date;
}

/** Meetings carry a start time only; a calendar needs an end. */
export const MEETING_MINUTES = 30;

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
  const link = (path: string | null) => (path && !o.busyOnly ? `${origin}${path}` : null);
  const label = (text: string) => (o.busyOnly ? "Busy" : text);
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
        summary: label(`${ref} ${w.title}`),
        url: link(entityUrl("workItem", { orgSlug, id: ref })),
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
        summary: label(m.title),
        url: link(entityUrl("meeting", { orgSlug, id: m.id })),
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
        summary: label(`${i.projectKey}: ${i.name}`),
        start,
        end: new Date(Math.max(dayOf(i.endDate).getTime(), start.getTime()) + DAY),
        allDay: true,
        lastModified: i.updatedAt,
      });
    }
  }

  return out;
}
