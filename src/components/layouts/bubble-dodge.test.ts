// COSMOS-34: the floating agent bubble must move off whatever tappable control
// it would cover, at every viewport size. Foreman's earlier attempt gated the
// logic on a phone-width media query and so did nothing on phones in
// landscape; these cases use both shapes.
import { describe, it, expect } from "vitest";
import {
  candidateOffsets,
  pickOffset,
  restingBox,
  LIFT_STEP,
  EDGE,
  type Box,
  type Offset,
} from "./bubble-dodge";

// Resting spots: bottom-right, 48px square.
const PORTRAIT: Box = { left: 326, top: 712, width: 48, height: 48 }; // 390x844
const LANDSCAPE: Box = { left: 772, top: 318, width: 48, height: 48 }; // 844x390

/** A blocker made of rectangles: blocked if the point falls inside any of them. */
function blockedBy(...rects: Box[]) {
  return (x: number, y: number) =>
    rects.some((r) => x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height);
}

describe("pickOffset", () => {
  it("stays put when nothing is underneath", () => {
    expect(pickOffset(PORTRAIT, 390, () => false)).toEqual({ x: 0, y: 0 });
  });

  it("lifts above a control under its resting spot (portrait)", () => {
    // A "View all" link right where the bubble rests.
    const link = { left: 300, top: 720, width: 80, height: 24 };
    expect(pickOffset(PORTRAIT, 390, blockedBy(link))).toEqual({ x: 0, y: -LIFT_STEP });
  });

  it("dodges in landscape too, where the viewport is wider than a phone breakpoint", () => {
    // A kanban card under the bubble on an 844x390 viewport.
    const card = { left: 600, top: 300, width: 240, height: 80 };
    const o = pickOffset(LANDSCAPE, 844, blockedBy(card));
    expect(o).not.toEqual({ x: 0, y: 0 });
    // ...and the chosen slot really is clear of the card.
    expect(blockedBy(card)(LANDSCAPE.left + o.x + 24, LANDSCAPE.top + o.y + 24)).toBe(false);
  });

  it("lifts past a tall control in several steps", () => {
    const tall = { left: 0, top: 600, width: 390, height: 170 };
    expect(pickOffset(PORTRAIT, 390, blockedBy(tall))).toEqual({ x: 0, y: -3 * LIFT_STEP });
  });

  it("moves to the left edge when the whole right side is taken", () => {
    const rightColumn = { left: 200, top: 0, width: 190, height: 844 };
    expect(pickOffset(PORTRAIT, 390, blockedBy(rightColumn))).toEqual({
      x: -(PORTRAIT.left - EDGE),
      y: 0,
    });
  });

  it("stays at rest when every slot is blocked rather than trading one covered control for another", () => {
    expect(pickOffset(PORTRAIT, 390, () => true)).toEqual({ x: 0, y: 0 });
  });
});

describe("candidateOffsets", () => {
  it("never proposes a slot above the viewport", () => {
    for (const o of candidateOffsets(LANDSCAPE, 844)) {
      expect(LANDSCAPE.top + o.y).toBeGreaterThanOrEqual(EDGE);
    }
  });
});

// ---------------------------------------------------------------------------
// Feedback item 46d8ea78: "the cosmo agent widget starts darting around the
// screen at random".
//
// `pickOffset` was never the problem -- it is pure and deterministic. The fault
// was in how the bubble's RESTING box was measured before being handed to it.
// These cases pin the two properties that make the dodge settle.
// ---------------------------------------------------------------------------

describe("restingBox", () => {
  const REST: Box = { left: 326, top: 712, width: 48, height: 48 };

  /** The rect a settled bubble reports with `applied` in force and no scale. */
  const settledRect = (applied: Offset) => ({
    left: REST.left + applied.x,
    top: REST.top + applied.y,
    width: REST.width,
    height: REST.height,
  });

  it("recovers the resting box when nothing is applied", () => {
    expect(restingBox(settledRect({ x: 0, y: 0 }), 48, 48, { x: 0, y: 0 })).toEqual(REST);
  });

  it("recovers the SAME resting box once a dodge offset is applied", () => {
    // The invariant: what the bubble decides must not depend on where it has
    // already moved to, or each move perturbs the next decision.
    const applied = { x: -310, y: -56 };
    expect(restingBox(settledRect(applied), 48, 48, applied)).toEqual(REST);
  });

  it("is unmoved by a hover scale", () => {
    // `hover:scale-105` grows the rect about its centre: 48 -> 50.4, so each
    // corner shifts 1.2px while the centre stays put.
    const scaled = { left: 324.8, top: 710.8, width: 50.4, height: 50.4 };
    expect(restingBox(scaled, 48, 48, { x: 0, y: 0 })).toEqual(REST);
  });

  it("the corner-based measurement it replaced really did move under that scale", () => {
    // Positive control for the case above: without it, "is unmoved by a hover
    // scale" would pass just as happily against the formula that had the bug.
    const scaled = { left: 324.8, top: 710.8, width: 50.4, height: 50.4 };
    const corner = { left: scaled.left, top: scaled.top };
    expect(corner.left).not.toBe(REST.left);
    expect(corner.top).not.toBe(REST.top);
  });

  it("falls back to the measured size when there is no layout box", () => {
    // offsetWidth/offsetHeight are 0 in jsdom and for a display:none element.
    expect(restingBox(settledRect({ x: 0, y: 0 }), 0, 0, { x: 0, y: 0 })).toEqual(REST);
  });
});

describe("the dodge loop settles", () => {
  const REST: Box = { left: 326, top: 712, width: 48, height: 48 };
  const VIEWPORT = 390;

  /**
   * Run the decision loop the way `useDodge` does.
   *
   * `travelled` models how far a move has got by the time the next check fires:
   * 1 is a settled bubble (what NOT animating the offset guarantees), and
   * anything less is a check landing mid-transition -- the old behaviour, where
   * the 120ms throttle was shorter than the 200ms transition.
   */
  function run(blocked: (x: number, y: number) => boolean, travelled: number, steps = 12) {
    let applied: Offset = { x: 0, y: 0 };
    const chosen: Offset[] = [];
    for (let i = 0; i < steps; i++) {
      const rect = {
        left: REST.left + applied.x * travelled,
        top: REST.top + applied.y * travelled,
        width: REST.width,
        height: REST.height,
      };
      const next = pickOffset(restingBox(rect, REST.width, REST.height, applied), VIEWPORT, blocked);
      chosen.push(next);
      applied = next;
    }
    return chosen;
  }

  // A control covering the resting spot, with its top edge partway up the first
  // lifted slot -- so a measurement that is off by even part of a lift flips
  // the answer.
  const blocked = (x: number, y: number) => y >= 690 && x >= 300;

  it("reaches a fixed point when the bubble is settled before each check", () => {
    const chosen = run(blocked, 1);
    const settled = chosen.slice(1);
    expect(new Set(settled.map((o) => `${o.x},${o.y}`)).size).toBe(1);
    // ...and the slot it settles on really is clear.
    const final = chosen[chosen.length - 1];
    expect(blocked(REST.left + final.x + 24, REST.top + final.y + 24)).toBe(false);
  });

  it("did NOT reach one while a check could land mid-move", () => {
    // Positive control: proves the harness above can actually detect the
    // oscillation, so the fixed point it reports is a real result.
    const chosen = run(blocked, 0.5);
    expect(new Set(chosen.map((o) => `${o.x},${o.y}`)).size).toBeGreaterThan(1);
  });
});
