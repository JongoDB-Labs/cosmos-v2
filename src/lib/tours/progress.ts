/**
 * What this browser remembers about a walkthrough between visits: the step it
 * was left on, and the steps a question was asked on.
 *
 * Per browser rather than per account, like `seen.ts`. A reader who closes the
 * tab halfway through a sixty-step walkthrough, or whose session expires, comes
 * back to the same browser far more often than to a different machine, and the
 * way back to where they were has to survive that.
 *
 * The questions themselves are NOT kept: each step's conversation is deleted
 * when the card closes (see components/tour/ask-threads.ts). Only the fact that
 * a step was asked about is, so the step can be found again.
 *
 * Every read degrades to "nothing remembered" (a private window, cleared
 * storage, a shape some earlier version wrote). Losing a convenience is fine;
 * a launcher or card that throws is not.
 */

const PROGRESS_KEY = "cosmos:tour-progress";
const ASKED_KEY = "cosmos:tour-asked";

function readMap<T>(key: string): Record<string, T> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function writeMap(key: string, map: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(map));
  } catch {
    /* a convenience, never a requirement */
  }
}

/** Where this browser left off in a given tour, or 0. */
export function readProgress(tourId: string): number {
  const n = readMap<unknown>(PROGRESS_KEY)[tourId];
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
}

export function writeProgress(tourId: string, index: number): void {
  writeMap(PROGRESS_KEY, { ...readMap(PROGRESS_KEY), [tourId]: index });
}

/** The ids of the steps in a tour that a question was asked on, in this browser. */
export function readAskedSteps(tourId: string): Set<string> {
  const ids = readMap<unknown>(ASKED_KEY)[tourId];
  return new Set(Array.isArray(ids) ? ids.filter((v): v is string => typeof v === "string") : []);
}

export function markStepAsked(tourId: string, stepId: string): void {
  const asked = readAskedSteps(tourId);
  if (asked.has(stepId)) return;
  asked.add(stepId);
  writeMap(ASKED_KEY, { ...readMap(ASKED_KEY), [tourId]: [...asked] });
}
