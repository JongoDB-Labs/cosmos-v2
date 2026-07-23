// src/lib/ai/date-input.ts
//
// Cosmo sets CALENDAR dates (due dates, start dates, sprint windows) from natural
// language the model turns into a date string. The app treats these as whole
// calendar days, not instants. The model typically emits "2026-07-24T00:00:00Z"
// (or a bare "2026-07-24", also parsed as UTC midnight) for "July 24"; stored
// verbatim that instant renders as the PREVIOUS day for any viewer west of UTC
// (all of the Americas) — the off-by-one users hit.
//
// Fix: snap every model-supplied date to NOON UTC of its intended calendar day.
// Noon UTC falls on the same calendar day for every populated timezone
// (UTC-12 … UTC+13), so a due date can never slip a day on display, regardless of
// where the viewer is.

import { z } from "zod";

/**
 * Accepts what the model realistically emits for a date: a bare calendar date
 * ("2026-07-24") or a full ISO-8601 string. Anything `Date` can parse is allowed;
 * the executor normalizes it to a calendar day via {@link toCalendarNoonUTC}.
 */
export const calendarDateInput = z
  .string()
  .refine((s) => !Number.isNaN(new Date(s).getTime()), {
    message: "must be a calendar date (YYYY-MM-DD) or an ISO-8601 datetime",
  });

/**
 * Snap a model-supplied date string to NOON UTC of its (UTC) calendar day.
 * Returns null for null/empty/unparseable input. This is the single place Cosmo's
 * calendar-date fields (work-item due/start, cycle start/end) are turned into a
 * stored instant, so they display on the intended day in every timezone.
 */
export function toCalendarNoonUTC(input: string | null | undefined): Date | null {
  if (!input) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0, 0),
  );
}
