/**
 * Time-tracking estimate, as size bands.
 *
 * Estimates are stored in SECONDS (Jira's worklog unit), which is the right
 * storage choice and the wrong thing to put in a filter bar — nobody asks a
 * board for "items estimated at 14400". They ask for the small stuff, or the
 * multi-day stuff.
 *
 * So this follows the same reasoning as the due-date presets: a bar is for
 * quick lenses, and a numeric comparator (`> 5`) makes the reader choose an
 * operator, a number and a unit before they see anything. Bands answer the
 * question directly.
 *
 * The boundaries are working days, not round numbers: 4h is "half a day", 8h is
 * "about a day", 24h is "most of a week". A band at 10h would be arithmetically
 * tidier and mean nothing to anyone planning a sprint.
 *
 * ONE AXIS ONLY. "Has blown its estimate" (timeSpent > originalEstimate) is a
 * genuinely useful lens, but it is a question about health rather than size —
 * folding it in here would make the control answer two questions at once, and
 * the reader could not tell which one filtered their board.
 */

export type EstimateBand = "any" | "none" | "lt4h" | "4to8h" | "1to3d" | "gt3d";

export const ESTIMATE_BANDS: { value: EstimateBand; label: string }[] = [
  { value: "any", label: "Any estimate" },
  { value: "none", label: "No estimate" },
  { value: "lt4h", label: "Under 4h" },
  { value: "4to8h", label: "4–8h" },
  { value: "1to3d", label: "1–3 days" },
  { value: "gt3d", label: "Over 3 days" },
];

const HOUR = 3600;
const DAY = 8 * HOUR; // a working day, not 24 — this is effort, not elapsed time

export function matchesEstimateBand(
  seconds: number | null | undefined,
  band: EstimateBand,
): boolean {
  if (band === "any") return true;
  // `== null` rather than falsiness: a deliberate 0 is an estimate ("no work
  // expected"), not the absence of one. Same trap as story points.
  if (seconds == null) return band === "none";
  if (band === "none") return false;

  switch (band) {
    case "lt4h":
      return seconds < 4 * HOUR;
    case "4to8h":
      return seconds >= 4 * HOUR && seconds <= DAY;
    case "1to3d":
      return seconds > DAY && seconds <= 3 * DAY;
    case "gt3d":
      return seconds > 3 * DAY;
    default:
      return true;
  }
}

/** True when any item carries an estimate — the control hides itself otherwise. */
export function hasAnyEstimate(items: { originalEstimate?: number | null }[]): boolean {
  return items.some((i) => i.originalEstimate != null);
}
