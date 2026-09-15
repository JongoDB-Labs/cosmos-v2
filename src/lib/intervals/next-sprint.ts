/**
 * Pure helpers for the "auto-start the next sprint" flow (sprint-planning Phase 4).
 * After a sprint is completed we offer to start the following one, pre-filled with
 * the SAME duration and an incremented title (e.g. two-week "Sprint 1" → two-week
 * "Sprint 2"). All logic here is I/O-free so it can be unit-tested; the component
 * does the fetch/create/activate.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Increment the last run of digits in an interval name, preserving zero-padding.
 *   "Sprint 1"              → "Sprint 2"
 *   "Increment 1 · Sprint 3" → "Increment 1 · Sprint 4"
 *   "Sprint 09"             → "Sprint 10"
 * When the name has no digits at all, append " 2".
 */
function bumpName(name: string): string {
  const trimmed = name.trim();
  // Last run of digits: a \d+ with no further digits anywhere after it.
  const match = trimmed.match(/\d+(?!.*\d)/);
  if (!match) return trimmed ? `${trimmed} 2` : "Sprint 2";
  const digits = match[0];
  const next = String(Number(digits) + 1).padStart(digits.length, "0");
  const at = match.index ?? 0;
  return trimmed.slice(0, at) + next + trimmed.slice(at + digits.length);
}

/** Names compare the way a human reads them: trimmed and case-insensitive. */
const normalizeName = (s: string) => s.trim().toLowerCase();

/**
 * The name to pre-fill for the sprint after `name`, skipping any already in use.
 *
 * Teams routinely plan a sprint or two AHEAD, so by the time "Sprint 1" is
 * completed "Sprint 2" usually exists already. Nothing checked, so accepting the
 * pre-filled suggestion created a SECOND "Sprint 2" — and because the interval
 * `number` is `max + 1` and stays unique, that read as a rendering bug rather
 * than two real rows, which is what made it hard to report.
 *
 * `taken` is optional so existing callers keep their behaviour; pass the
 * project's interval names to get collision-free suggestions.
 */
export function nextSprintName(
  name: string,
  taken: Iterable<string> = [],
): string {
  const used = new Set([...taken].map(normalizeName));
  let candidate = bumpName(name);

  // Bounded: a project where every candidate is taken must still terminate and
  // hand back something editable rather than hang the dialog.
  for (let i = 0; i < 1000 && used.has(normalizeName(candidate)); i++) {
    candidate = bumpName(candidate);
  }
  return candidate;
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
 *
 * Pass `takenNames` — the project's existing interval names — so the suggested
 * title skips one that already exists. Without it a team that plans ahead ends
 * up with two sprints of the same name.
 */
export function computeNextSprintDefaults(
  prev: {
    name: string;
    startDate: string | Date;
    endDate: string | Date;
  },
  takenNames: Iterable<string> = [],
): NextSprintDefaults {
  const start = toDateOnly(prev.startDate);
  const end = toDateOnly(prev.endDate);
  // Guard against an inverted range; a negative span would shrink the sprint.
  const spanMs = Math.max(0, end.getTime() - start.getTime());
  const newStart = new Date(end.getTime() + DAY_MS);
  const newEnd = new Date(newStart.getTime() + spanMs);
  return {
    name: nextSprintName(prev.name, takenNames),
    startDate: toDateInput(newStart),
    endDate: toDateInput(newEnd),
  };
}
