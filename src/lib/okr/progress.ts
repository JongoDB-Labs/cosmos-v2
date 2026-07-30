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
 * An objective's whole-percent progress.
 *
 * Key results win when the objective has any: that is the established roll-up
 * and changing it would move numbers people already read.
 *
 * An objective with NO key results used to be hardcoded to 0 — permanently, no
 * matter what was happening underneath. That is the gap #52 closes: an
 * objective tracked by linked delivery (Features) now reports how much of that
 * delivery is done. Because the only objectives affected are the ones that
 * previously read a constant 0 AND have links (a capability that did not exist
 * before), no pre-existing figure can change.
 *
 * Order matters and is deliberate: KRs first, then links, then 0.
 */
export function objectiveProgressPercent(
  keyResultPercents: readonly number[],
  linkedTotal: number,
  linkedDone: number,
): number {
  if (keyResultPercents.length > 0) {
    return Math.round(
      keyResultPercents.reduce((sum, p) => sum + p, 0) / keyResultPercents.length,
    );
  }
  if (linkedTotal > 0) {
    return Math.round((Math.min(linkedDone, linkedTotal) / linkedTotal) * 100);
  }
  return 0;
}
