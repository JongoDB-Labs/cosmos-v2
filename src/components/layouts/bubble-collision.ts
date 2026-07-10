/**
 * Pure collision-avoidance geometry for the floating agent bubble.
 *
 * The bubble is a fixed bottom-right affordance. On small (mobile) viewports
 * other *pinned* tappable controls can share that corner — the settings
 * save/discard bar (a fixed, full-width bottom bar) or the sticky bulk-action
 * pills on the boards/table/PM registers. When they do, the bubble covers their
 * buttons and they can't be tapped.
 *
 * This module answers one question with no DOM/layout coupling (so it's cheap to
 * unit-test): given the bubble's resting rectangle and the rectangles of nearby
 * pinned controls, how many pixels should the bubble be lifted straight up so it
 * no longer overlaps any of them (keeping `gap` px of clearance)?
 *
 * Only obstacles sharing the bubble's horizontal column can ever overlap it, so
 * a vertical lift is always sufficient to clear them. The DOM-facing caller
 * (`floating-agent-bubble.tsx`) is responsible for collecting the obstacle rects
 * (pinned, visible, near the bubble) and applying the returned offset.
 */

export interface CollisionRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface CollisionOptions {
  /** Minimum clearance to keep between the bubble and any obstacle (px). */
  gap?: number;
  /** Never lift the bubble further than this (px) — keeps it from wandering. */
  maxLift?: number;
}

const DEFAULT_GAP = 8;
const DEFAULT_MAX_LIFT = 260;

/**
 * Return how far (px) to lift the bubble so its footprint clears every obstacle.
 * Returns 0 when the resting position is already clear, and never more than
 * `maxLift`.
 */
export function computeBubbleLift(
  base: CollisionRect,
  obstacles: CollisionRect[],
  options: CollisionOptions = {},
): number {
  const gap = options.gap ?? DEFAULT_GAP;
  const maxLift = options.maxLift ?? DEFAULT_MAX_LIFT;

  // Obstacles outside the bubble's horizontal column can never overlap it, no
  // matter how far it is lifted — drop them up front.
  const inColumn = obstacles.filter(
    (o) => o.right > base.left - gap && o.left < base.right + gap,
  );
  if (inColumn.length === 0) return 0;

  let lift = 0;
  // Each pass lifts the bubble just above the highest-topped obstacle it still
  // overlaps; that clears every obstacle currently in range, but the higher
  // position may bring a new one into range, so repeat until clear. `lift`
  // strictly increases each pass, so this converges — the bound is a safety net.
  for (let pass = 0; pass <= inColumn.length; pass++) {
    const top = base.top - lift;
    const bottom = base.bottom - lift;
    let highestTop = Infinity;
    for (const o of inColumn) {
      const overlapsVertically = o.bottom > top - gap && o.top < bottom + gap;
      if (overlapsVertically && o.top < highestTop) highestTop = o.top;
    }
    if (highestTop === Infinity) break; // clear at this height
    const needed = base.bottom - (highestTop - gap);
    if (needed <= lift) break; // obstacle sits at/above the bubble; lifting won't help
    lift = needed;
    if (lift >= maxLift) return maxLift;
  }
  return lift;
}
