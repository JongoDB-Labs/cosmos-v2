/**
 * COSMOS-202: write an iCalendar (RFC 5545) feed that Outlook, Google Calendar
 * and Apple Calendar can subscribe to ("Add calendar > Subscribe from web").
 *
 * Pure: no I/O, no clock unless one is passed, so the same input always yields
 * the same bytes and a feed's ETag only changes when its content does.
 */

export interface IcsEvent {
  /** Stable across fetches, or clients duplicate the event on every refresh. */
  uid: string;
  summary: string;
  description?: string | null;
  url?: string | null;
  start: Date;
  /** Exclusive end. For an all-day event, the day AFTER the last day. */
  end: Date;
  allDay: boolean;
  lastModified?: Date | null;
}

export interface IcsCalendar {
  /** PRODID, e.g. "-//Example//Calendar feed//EN". */
  prodId: string;
  /** Shown as the calendar's name when a client subscribes. */
  name: string;
  events: IcsEvent[];
  /** Stamped on every event (DTSTAMP). Pass it in to keep output reproducible. */
  stamp: Date;
  /** How often clients should re-fetch, in minutes (a hint; Outlook may ignore it). */
  refreshMinutes?: number;
}

/** TEXT values escape backslash, semicolon and comma, and newlines become "\n". */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Lines longer than 75 octets are folded: CRLF then a single space. Counted in
 * UTF-8 bytes, never splitting a multi-byte character.
 */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
      limit = 74; // continuation lines start with the folding space
    }
    current += ch;
    bytes += n;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 20261022T143000Z */
export function formatUtc(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** 20261022: a calendar date, read in UTC (how the app stores date-only values). */
export function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function eventLines(e: IcsEvent, stamp: Date): string[] {
  const lines = ["BEGIN:VEVENT", `UID:${escapeText(e.uid)}`, `DTSTAMP:${formatUtc(stamp)}`];
  if (e.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${formatDate(e.start)}`, `DTEND;VALUE=DATE:${formatDate(e.end)}`);
  } else {
    lines.push(`DTSTART:${formatUtc(e.start)}`, `DTEND:${formatUtc(e.end)}`);
  }
  lines.push(`SUMMARY:${escapeText(e.summary)}`);
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
  if (e.url) lines.push(`URL:${e.url}`);
  if (e.lastModified) lines.push(`LAST-MODIFIED:${formatUtc(e.lastModified)}`);
  // A feed is read-only for the subscriber: show it as busy, never as an invite.
  lines.push("TRANSP:OPAQUE", "END:VEVENT");
  return lines;
}

export function buildIcs(cal: IcsCalendar): string {
  const refresh = cal.refreshMinutes ?? 60;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${cal.prodId}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(cal.name)}`,
    `REFRESH-INTERVAL;VALUE=DURATION:PT${refresh}M`,
    `X-PUBLISHED-TTL:PT${refresh}M`,
    ...cal.events.flatMap((e) => eventLines(e, cal.stamp)),
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
