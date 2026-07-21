/**
 * Pure helpers for the "auto-start the next sprint" flow (sprint-planning Phase 4).
 * After a sprint is completed we offer to start the following one, pre-filled with
 * the SAME duration and an incremented title (e.g. two-week "Sprint 1" → two-week
 * "Sprint 2"). All logic here is I/O-free so it can be unit-tested; the component
 * does the fetch/create/activate.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Increment the last run of digits in a cycle name, preserving zero-padding.
 *   "Sprint 1"              → "Sprint 2"
 *   "Increment 1 · Sprint 3" → "Increment 1 · Sprint 4"
 *   "Sprint 09"             → "Sprint 10"
 * When the name has no digits at all, append " 2".
 */
export function nextSprintName(name: string): string {
  const trimmed = name.trim();
  // Last run of digits: a \d+ with no further digits anywhere after it.
  const match = trimmed.match(/\d+(?!.*\d)/);
  if (!match) return trimmed ? `${trimmed} 2` : "Sprint 2";
  const digits = match[0];
  const next = String(Number(digits) + 1).padStart(digits.length, "0");
  const at = match.index ?? 0;
  return trimmed.slice(0, at) + next + trimmed.slice(at + digits.length);
}

/** Parse a YYYY-MM-DD (or ISO datetime) value to a UTC date-only Date, TZ-safe. */
function toDateOnly(v: string | Date): Date {
  const s = typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10);
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Format a Date as YYYY-MM-DD (the shape the date <input> and create form use). */
function toDateInput(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface NextSprintDefaults {
  /** Suggested title with the trailing iteration incremented. */
  name: string;
  /** YYYY-MM-DD — starts the day after the completed sprint ended. */
  startDate: string;
  /** YYYY-MM-DD — same span (in days) as the completed sprint. */
  endDate: string;
}

/**
 * Compute the pre-filled defaults for the sprint that follows `prev`: same
 * duration (day span), starting the day after `prev` ended, with an incremented
 * title. Dates come back as YYYY-MM-DD so they drop straight into the create form.
 */
export function computeNextSprintDefaults(prev: {
  name: string;
  startDate: string | Date;
  endDate: string | Date;
}): NextSprintDefaults {
  const start = toDateOnly(prev.startDate);
  const end = toDateOnly(prev.endDate);
  // Guard against an inverted range; a negative span would shrink the sprint.
  const spanMs = Math.max(0, end.getTime() - start.getTime());
  const newStart = new Date(end.getTime() + DAY_MS);
  const newEnd = new Date(newStart.getTime() + spanMs);
  return {
    name: nextSprintName(prev.name),
    startDate: toDateInput(newStart),
    endDate: toDateInput(newEnd),
  };
}
