/**
 * Plan-drift phantoms for the Timeline / Gantt board.
 *
 * The solid bar is always the ACTUAL span. The phantoms show where the PLAN
 * disagreed with it, and each one answers exactly one question:
 *
 *   START DRIFT — one phantom spanning planned start <-> actual start. Its side
 *     falls out of the sign, which is why the colours can be read positionally:
 *       started LATE  -> planned start is BEFORE the block, phantom sits to its
 *                        LEFT.  AMBER.
 *       started EARLY -> planned start is AFTER the block's left edge, phantom
 *                        sits to the RIGHT of it, over the block's head. GREEN.
 *
 *   END DRIFT — a phantom spanning planned end -> actual end, only when the end
 *     slipped. RED, and drawn last so it wins wherever it overlaps.
 *
 * This replaces a single ghost of the WHOLE planned span tinted one colour. That
 * version could not show a slip: a late item just re-coloured its entire planned
 * bar red, which said "this is late" but never "late by THIS much, HERE".
 *
 * Dates in, dates out — no pixels. The caller maps to x/width with the same
 * projection it uses for the bars, so the phantoms cannot drift from them.
 */

export type DriftColor = "amber" | "green" | "red";

export interface DriftPhantom {
  /** Inclusive left edge. */
  from: Date;
  /** Exclusive right edge. Never before `from`. */
  to: Date;
  color: DriftColor;
}

export interface PlanDriftInput {
  plannedStart: Date | null;
  plannedEnd: Date | null;
  actualStart: Date | null;
  /** `completedAt`, or today for something still running. */
  actualEnd: Date | null;
}

/**
 * The phantoms to draw, in PAINT ORDER — start drift first, end drift last, so a
 * caller that renders them in sequence gets red on top for free.
 *
 * Returns nothing when there is no actual span to compare against: with no
 * actuals the planned bar IS the solid bar, and a phantom of the plan behind the
 * plan is just a blur.
 */
export function planDriftPhantoms(input: PlanDriftInput): DriftPhantom[] {
  const { plannedStart, plannedEnd, actualStart, actualEnd } = input;
  const phantoms: DriftPhantom[] = [];

  if (!actualStart) return phantoms;

  // Start drift. Equal dates produce no phantom rather than a zero-width sliver.
  if (plannedStart) {
    const started = actualStart.getTime();
    const planned = plannedStart.getTime();
    if (started > planned) {
      phantoms.push({ from: plannedStart, to: actualStart, color: "amber" });
    } else if (started < planned) {
      phantoms.push({ from: actualStart, to: plannedStart, color: "green" });
    }
  }

  // End drift. Only ever a slip — an early finish is already visible as a short
  // bar, and colouring it would collide with the green that means "started
  // early" two pixels to the left.
  if (plannedEnd && actualEnd && actualEnd.getTime() > plannedEnd.getTime()) {
    phantoms.push({ from: plannedEnd, to: actualEnd, color: "red" });
  }

  return phantoms;
}
