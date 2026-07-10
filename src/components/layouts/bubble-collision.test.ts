import { describe, it, expect } from "vitest";
import { computeBubbleLift, type CollisionRect } from "./bubble-collision";

/**
 * Build the floating agent bubble's resting rect the way the CSS anchors it:
 * `right-4` (16px inset), a bottom offset (5.25rem ≈ 84px above the safe area),
 * and a 48px (h-12/w-12) square.
 */
function bubbleRect(
  viewportW: number,
  viewportH: number,
  { inset = 16, bottomOffset = 84, size = 48 } = {},
): CollisionRect {
  const right = viewportW - inset;
  const bottom = viewportH - bottomOffset;
  return { right, left: right - size, bottom, top: bottom - size };
}

/** A pinned bottom bar spanning `left..right`, `height` tall, `fromBottom` up. */
function bottomBar(
  viewportH: number,
  { left, right, height, fromBottom }: { left: number; right: number; height: number; fromBottom: number },
): CollisionRect {
  const bottom = viewportH - fromBottom;
  return { left, right, bottom, top: bottom - height };
}

const overlaps = (a: CollisionRect, b: CollisionRect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

const lifted = (r: CollisionRect, lift: number): CollisionRect => ({
  ...r,
  top: r.top - lift,
  bottom: r.bottom - lift,
});

describe("computeBubbleLift", () => {
  it("returns 0 when there are no obstacles", () => {
    const base = bubbleRect(390, 844);
    expect(computeBubbleLift(base, [])).toBe(0);
  });

  it("ignores obstacles outside the bubble's horizontal column", () => {
    // A bottom-left pill (e.g. the wake-word indicator) that never reaches the
    // bubble's column must not move the bubble.
    const base = bubbleRect(390, 844);
    const leftPill = bottomBar(844, { left: 16, right: 150, height: 40, fromBottom: 80 });
    expect(computeBubbleLift(base, [leftPill])).toBe(0);
  });

  it("ignores obstacles that don't vertically overlap the resting bubble", () => {
    const base = bubbleRect(390, 844);
    const highBar: CollisionRect = { left: 16, right: 374, top: 100, bottom: 150 };
    expect(computeBubbleLift(base, [highBar])).toBe(0);
  });

  // The real-world collision: the settings save/discard bar is a fixed,
  // full-width bottom bar whose right-hand buttons sit under the bubble.
  it.each([320, 360, 390, 430])(
    "lifts the bubble clear of a full-width save bar at %ipx wide (portrait)",
    (width) => {
      const height = 844;
      const base = bubbleRect(width, height);
      // Save bar: left-4/right-4, ~72px above the bottom, ~52px tall.
      const saveBar = bottomBar(height, { left: 16, right: width - 16, height: 52, fromBottom: 72 });
      expect(overlaps(base, saveBar)).toBe(true); // precondition: it collides

      const lift = computeBubbleLift(base, [saveBar]);
      expect(lift).toBeGreaterThan(0);
      // After lifting, the bubble must clear the bar with >= gap px of space.
      expect(overlaps(lifted(base, lift), saveBar)).toBe(false);
      expect(base.bottom - lift).toBeLessThanOrEqual(saveBar.top - 8);
    },
  );

  it("lifts the bubble clear of a bottom bar in landscape orientation", () => {
    // 844x390 landscape (portrait phone rotated).
    const width = 844;
    const height = 390;
    const base = bubbleRect(width, height);
    const bar = bottomBar(height, { left: 16, right: width - 16, height: 48, fromBottom: 72 });
    expect(overlaps(base, bar)).toBe(true);

    const lift = computeBubbleLift(base, [bar]);
    expect(lift).toBeGreaterThan(0);
    expect(overlaps(lifted(base, lift), bar)).toBe(false);
    // Bubble stays on-screen (doesn't get lifted above the viewport top).
    expect(base.top - lift).toBeGreaterThan(0);
  });

  it("clears a stack of two bars by lifting above the higher one", () => {
    const height = 844;
    const base = bubbleRect(390, height);
    const lower = bottomBar(height, { left: 16, right: 374, height: 44, fromBottom: 72 });
    const upper = bottomBar(height, { left: 16, right: 374, height: 44, fromBottom: 124 });

    const lift = computeBubbleLift(base, [lower, upper]);
    const moved = lifted(base, lift);
    expect(overlaps(moved, lower)).toBe(false);
    expect(overlaps(moved, upper)).toBe(false);
  });

  it("never lifts further than maxLift for an unclearable obstacle", () => {
    const base = bubbleRect(390, 844);
    // A pathologically tall obstacle spanning most of the column height.
    const tall: CollisionRect = { left: 16, right: 374, top: 100, bottom: base.bottom };
    expect(computeBubbleLift(base, [tall], { maxLift: 200 })).toBe(200);
  });
});
