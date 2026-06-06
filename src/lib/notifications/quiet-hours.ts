export interface QuietHoursPrefs {
  dndEnabled: boolean;
  dndStart: string | null; // "HH:MM"
  dndEnd: string | null; // "HH:MM"
  dndTimezone: string | null; // IANA
}

/**
 * Wall-clock minutes-since-midnight in the given IANA timezone for `now`.
 * Uses Intl with hour12:false; robust across DST. Throws on an invalid tz.
 */
function minutesInTimezone(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hhRaw = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const hour = hhRaw === 24 ? 0 : hhRaw; // some envs render midnight as "24"
  const min = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + min;
}

function parseHHMM(s: string): number | null {
  const m = s.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Is `now` within the user's configured quiet-hours window? Pure function —
 * the instant is supplied so it's deterministic and testable. Handles same-day
 * (start < end) and overnight (start > end) windows. Returns false on any
 * misconfiguration (disabled, missing fields, bad tz, zero-length window) so
 * push is never suppressed by accident.
 */
export function isInQuietHours(now: Date, prefs: QuietHoursPrefs): boolean {
  if (!prefs.dndEnabled) return false;
  if (!prefs.dndStart || !prefs.dndEnd || !prefs.dndTimezone) return false;

  const start = parseHHMM(prefs.dndStart);
  const end = parseHHMM(prefs.dndEnd);
  if (start === null || end === null) return false;
  if (start === end) return false; // zero-length window = effectively off

  let cur: number;
  try {
    cur = minutesInTimezone(now, prefs.dndTimezone);
  } catch {
    return false; // invalid timezone → don't suppress
  }

  if (start < end) {
    return cur >= start && cur < end; // same-day window
  }
  return cur >= start || cur < end; // overnight window
}
