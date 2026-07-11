/**
 * Chat/DM timestamp helpers (FR 78b5b1bd).
 *
 * Users want to read the *minute* a message was sent, not the second, and they
 * don't want a timestamp repeated on every message. A timestamp is surfaced only
 * at the start of a new "time group" — the first message of the day, or the
 * first message after a stretch of silence — and the precise time (with seconds)
 * is available on demand by clicking a message.
 */

/**
 * Inactivity gap that starts a fresh timestamp within a day. After this much
 * quiet, the next message is treated as a new burst of conversation and shows
 * its time again. Tunable in one place so the threshold stays consistent
 * everywhere it's applied.
 */
export const INACTIVITY_GAP_MS = 3 * 60 * 60 * 1000; // 3 hours

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * True when `iso` should show its own timestamp: it's the first message (no
 * `prevIso`), it's on a different calendar day than the previous message, or at
 * least `INACTIVITY_GAP_MS` has elapsed since the previous message. Otherwise
 * the message belongs to the previous burst and its timestamp is suppressed.
 */
export function startsNewTimeGroup(
  prevIso: string | null | undefined,
  iso: string,
): boolean {
  if (!prevIso) return true;
  const prev = new Date(prevIso);
  const cur = new Date(iso);
  if (!sameLocalDay(prev, cur)) return true;
  return cur.getTime() - prev.getTime() >= INACTIVITY_GAP_MS;
}

/** Minute-granularity time, e.g. "2:05 PM" — the default chat/DM reading. */
export function formatMinuteTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Full date + second-precise time, revealed when a message is clicked. */
export function formatPreciseTimestamp(iso: string): string {
  return new Date(iso).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}
