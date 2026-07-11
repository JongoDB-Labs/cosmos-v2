/**
 * Fraction (0–1) of a key result's progress from start → target, clamped.
 *
 * The core formula `(current - start) / (target - start)` is already
 * direction-agnostic: it measures distance travelled from the baseline toward
 * the goal regardless of whether the goal is higher (revenue) or lower (latency,
 * cost, defects) than the baseline — as long as `start` is the baseline and
 * `target` is the goal. So `lowerIsBetter` does NOT change the number for real
 * ranges; it only disambiguates the degenerate `start === target` case (is
 * "at least target" or "at most target" the win condition?) and records the
 * metric's intended direction for done-detection and display elsewhere.
 *
 * Single source of truth for the OKR progress calc — used by the API roll-ups
 * and the client views.
 */
export function krFraction(
  start: number,
  current: number,
  target: number,
  lowerIsBetter = false,
): number {
  const clamp = (f: number) => Math.max(0, Math.min(1, f));
  if (lowerIsBetter) {
    if (start === target) return current <= target ? 1 : 0;
    return clamp((start - current) / (start - target));
  }
  if (target === start) return current >= target ? 1 : 0;
  return clamp((current - start) / (target - start));
}

/** Whole-percent (0–100) convenience wrapper. */
export function krProgressPercent(
  start: number,
  current: number,
  target: number,
  lowerIsBetter = false,
): number {
  return Math.round(krFraction(start, current, target, lowerIsBetter) * 100);
}

/**
 * Objective progress (0–100), rolled up from its "completion units":
 *
 *   - each key result contributes its own progress percent (`krPercents`), and
 *   - each work item linked DIRECTLY to the objective contributes 100 when done
 *     and 0 when not (`directTotal` items, `directDone` of them complete).
 *
 * The objective's progress is the mean of all these units. With no direct links
 * this is exactly the plain key-result average (backwards compatible); with no
 * key results it is the share of linked items that are done. Zero units → 0.
 *
 * Single source of truth shared by the objectives API roll-up and the client
 * card so the two never drift.
 */
export function objectiveProgressPercent(
  krPercents: number[],
  directTotal: number,
  directDone: number,
): number {
  const unitCount = krPercents.length + directTotal;
  if (unitCount === 0) return 0;
  const krSum = krPercents.reduce((sum, p) => sum + p, 0);
  const directSum = Math.max(0, Math.min(directDone, directTotal)) * 100;
  return Math.round((krSum + directSum) / unitCount);
}
