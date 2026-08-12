/**
 * Dates that are safe to render on the SERVER.
 *
 * `new Date(x).toLocaleDateString()` with no arguments formats using the
 * RUNTIME's locale and time zone. The server (a container, typically UTC and
 * a C/POSIX locale) and the browser (the user's machine) therefore produce
 * DIFFERENT TEXT for the same instant — and React throws hydration error #418
 * ("text content does not match"), which this app surfaces to the user as a
 * "Something went wrong" toast on the projects list.
 *
 * Pinning BOTH the locale and the time zone makes the string a pure function of
 * the instant, so both renders agree. UTC is the deliberate choice: these are
 * coarse "updated on" / "due" dates where a consistent, unambiguous date matters
 * more than the reader's midnight boundary, and it is the only zone the server
 * can know. Anything that genuinely needs the viewer's local time must render
 * client-side after mount, not here.
 *
 * There are ~107 `toLocale*` call sites in the app; this is the shared landing
 * point for converting the ones that render during SSR.
 */
const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

const DATE_MED_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});

const DATE_MEDIUM_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

const DATE_LONG_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "long",
  day: "numeric",
  year: "numeric",
});

/** `7/30/2026` — identical on server and client. Empty string for no date. */
export function formatDateStable(value: string | Date | null | undefined): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return DATE_FMT.format(d);
}

/** `Jul 30` — identical on server and client. Empty string for no date. */
export function formatDateShortStable(
  value: string | Date | null | undefined,
): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return DATE_MED_FMT.format(d);
}

/**
 * `Jul 30, 2026` — identical on server and client. Empty string for no date.
 *
 * The sprint-window format. Sprint and increment boundaries are calendar days
 * stored at midnight UTC, so formatting them in the reader's zone showed every
 * user west of UTC the day BEFORE the sprint actually started.
 */
export function formatDateMediumStable(
  value: string | Date | null | undefined,
): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return DATE_MEDIUM_FMT.format(d);
}

/** `July 30, 2026` — identical on server and client. Empty string for no date. */
export function formatDateLongStable(
  value: string | Date | null | undefined,
): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return DATE_LONG_FMT.format(d);
}
