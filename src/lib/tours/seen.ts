const SEEN_KEY = "cosmos:tours-seen";

/**
 * Which tours this browser has already been offered.
 *
 * Per browser rather than per account, matching how "What's new" already decides
 * it has shown you a release. Being re-offered a tour after switching machines
 * is a smaller annoyance than a server round-trip on every page load, and
 * neither is worth a table.
 *
 * Every path degrades to "seen nothing": a private window, cleared storage, or a
 * value some earlier version wrote in another shape. Being offered a tour twice
 * is recoverable; a launcher that throws is not.
 */
export function readSeenTours(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

export function markTourSeen(id: string): void {
  if (typeof window === "undefined") return;
  try {
    const next = readSeenTours();
    next.add(id);
    window.localStorage.setItem(SEEN_KEY, JSON.stringify([...next]));
  } catch {
    /* the offer simply repeats next time */
  }
}
