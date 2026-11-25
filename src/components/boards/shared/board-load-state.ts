/**
 * When a board's load failure should replace the board, and when it should not.
 *
 * A board view reads a few things it cannot draw without (its CRITICAL reads:
 * the board, its items...). Any of them can fail on a background refresh while
 * the view still holds data from an earlier load. Treating "any error" as
 * "nothing to show" threw a loaded board away whenever one refresh failed.
 *
 * The rule:
 * - FATAL (show LoadError in place of the board) when a read has never loaded,
 *   or when the server says the user may no longer see it: 401/403 on any
 *   critical read, or 404 on a read whose 404 means "hidden or gone" (the board
 *   detail, the ceremony payload, the project's items). An access error wins
 *   over everything else, and it LATCHES: it stays fatal until that read next
 *   succeeds over the network, so a later 500 cannot bring the old board back.
 * - REFRESH FAILED (keep the board, show a notice) when the last network fetch
 *   of a read failed for any other reason while it still has data.
 *
 * This decides fatal vs stale only. Each view keeps its own loading predicate.
 */
import type { FetchError } from "@/lib/query/json-fetcher";

export interface CriticalRead {
  /** The read's current error, or null. */
  error: unknown;
  /** Whether the read holds data from an earlier successful load. */
  hasData: boolean;
  /** Whether its last network fetch failed (an optimistic cache write does not clear this). */
  lastFetchFailed?: boolean;
  /** Set once an access error was seen; cleared only by a successful fetch. */
  accessLatched?: boolean;
  /** A 404 on this read means the user can't see it any more. */
  notFoundIsAccess?: boolean;
}

export interface BoardLoadVerdict {
  fatal: boolean;
  /** The error to describe when fatal (null when the fatal cause is a latch with no current error). */
  fatalError: unknown;
  refreshFailed: boolean;
}

/** The HTTP status a failed read carries (a FetchError's `status`), if any. */
function statusOf(error: unknown): number | undefined {
  // Read structurally rather than `instanceof FetchError`: tests that mock the
  // json-fetcher module replace the class, and a status is all this needs.
  const status = (error as Partial<FetchError> | null)?.status;
  return typeof status === "number" ? status : undefined;
}

export function isAccessError(error: unknown, notFoundIsAccess = false): boolean {
  const status = statusOf(error);
  if (status === 401 || status === 403) return true;
  return notFoundIsAccess && status === 404;
}

export function classifyBoardLoad(reads: readonly CriticalRead[]): BoardLoadVerdict {
  // Access first: a 403 must not hide behind another read's 500.
  for (const r of reads) {
    if (r.accessLatched || isAccessError(r.error, r.notFoundIsAccess)) {
      return { fatal: true, fatalError: r.error ?? null, refreshFailed: false };
    }
  }
  for (const r of reads) {
    if (r.error && !r.hasData) return { fatal: true, fatalError: r.error, refreshFailed: false };
  }
  const refreshFailed = reads.some(
    (r) => r.hasData && (r.lastFetchFailed ?? Boolean(r.error)),
  );
  return { fatal: false, fatalError: null, refreshFailed };
}

/** What a view remembers about one critical read between fetches. */
export interface ReadMemory {
  lastFetchFailed: boolean;
  accessLatched: boolean;
}

export const FRESH_READ: ReadMemory = { lastFetchFailed: false, accessLatched: false };

/** Fold one network fetch outcome into a read's memory. */
export function recordFetch(
  prev: ReadMemory,
  outcome: { ok: true } | { ok: false; error: unknown; notFoundIsAccess?: boolean },
): ReadMemory {
  if (outcome.ok) return FRESH_READ;
  return {
    lastFetchFailed: true,
    accessLatched: prev.accessLatched || isAccessError(outcome.error, outcome.notFoundIsAccess),
  };
}

/** A load error's message for LoadError's description. */
export function loadErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message;
  return undefined;
}
