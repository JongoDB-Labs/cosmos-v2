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

  it("never leaves its own column, even when the whole right side is taken", () => {
    // Feedback 36938fd0: "those objects are taking priority and kicking the
    // assistant bubble over to the left of the screen". Crossing the viewport
    // is never the lesser evil -- a launcher that changes corners is harder to
    // find than one that occasionally overlaps a card.
    const rightColumn = { left: 200, top: 0, width: 190, height: 844 };
    expect(pickOffset(PORTRAIT, 390, blockedBy(rightColumn))).toEqual({ x: 0, y: 0 });
  });

  it("keeps x at 0 for every blocker shape", () => {
    const shapes: Box[][] = [
      [{ left: 300, top: 720, width: 80, height: 24 }],
      [{ left: 0, top: 600, width: 390, height: 170 }],
      [{ left: 200, top: 0, width: 190, height: 844 }],
      [{ left: 0, top: 0, width: 390, height: 844 }],
      [
        { left: 300, top: 700, width: 90, height: 40 },
        { left: 300, top: 640, width: 90, height: 40 },
      ],
    ];
    for (const rects of shapes) {
      expect(pickOffset(PORTRAIT, 390, blockedBy(...rects)).x).toBe(0);
    }
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

// ---------------------------------------------------------------------------
// Feedback item 36938fd0: "assistant modal is colliding with other UI
// elements ... kicking the assistant bubble over to the left of the screen,
// sometimes causing it to jump between places erratically".
//
// This is the THIRD report of the bubble moving. 46d8ea78 was oscillation from
// a bad measurement (fixed 2.494.1) and is covered above. 67e6615d said "the
// companion is randomly over on the left at times" and was closed against that
// same fix, which never touched the side-swap. These cases pin the two
// remaining causes: a left-edge slot existed at all, and the choice was
// recomputed from scratch on every check, so a board scrolling under the
// corner re-picked continuously.
// ---------------------------------------------------------------------------

describe("the chosen slot is sticky", () => {
  it("stays in the slot it already holds while that slot is still clear", () => {
    // The scroll-flap case: the resting corner has cleared, but coming back
    // down only to lift again on the next card is the erratic jumping.
    const lifted: Offset = { x: 0, y: -LIFT_STEP };
    expect(pickOffset(PORTRAIT, 390, () => false, lifted)).toEqual(lifted);
  });

  it("gives up a held slot once something moves under it", () => {
    const lifted: Offset = { x: 0, y: -LIFT_STEP };
    const underTheLiftedSlot = { left: 300, top: PORTRAIT.top - LIFT_STEP, width: 90, height: 48 };
    expect(pickOffset(PORTRAIT, 390, blockedBy(underTheLiftedSlot), lifted)).not.toEqual(lifted);
  });

  it("ignores a held slot that is no longer on offer", () => {
    // A left-edge offset persisted from before this change, or one left over
    // from a taller viewport, must not pin the bubble off to the side forever.
    const stale: Offset = { x: -(PORTRAIT.left - EDGE), y: 0 };
    expect(pickOffset(PORTRAIT, 390, () => false, stale)).toEqual({ x: 0, y: 0 });
  });

  it("still returns the resting spot when it is clear and nothing is held", () => {
    expect(pickOffset(PORTRAIT, 390, () => false, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe("a board scrolling under the corner", () => {
  /**
   * A blocker that covers exactly the listed slots, named by lift index. The
   * sample points of slot `i` are the resting ones raised by `i * LIFT_STEP`,
   * and `isBlocked` is only ever called on sample points, so matching them
   * exactly models "a card sits under that slot" without hand-placing pixels.
   */
  function blockSlots(...idx: number[]) {
    const ys = new Set<number>();
    for (const i of idx) {
      for (const y of [4, PORTRAIT.height / 2, PORTRAIT.height - 4]) {
        ys.add(PORTRAIT.top + y - i * LIFT_STEP);
      }
    }
    return (_x: number, y: number) => ys.has(y);
  }

  const moves = (os: Offset[]) =>
    os.filter((o, i) => i > 0 && (o.x !== os[i - 1].x || o.y !== os[i - 1].y)).length;

  /**
   * The resting spot blocked on alternate frames: a gap between two cards
   * passing under the corner. Frame 0 is clear, so the run starts settled at
   * the resting spot and the first move is observable.
   */
  const flicker = (step: number) => (step % 2 === 1 ? blockSlots(0) : blockSlots());

  it("moves once off a flickering resting spot, then holds still", () => {
    let held: Offset | undefined = { x: 0, y: 0 };
    const chosen: Offset[] = [];
    for (let step = 0; step < 40; step++) {
      held = pickOffset(PORTRAIT, 390, flicker(step), held);
      chosen.push(held);
    }
    expect(moves(chosen)).toBe(1);
    expect(chosen[chosen.length - 1]).toEqual({ x: 0, y: -LIFT_STEP });
  });

  it("re-picked on every single frame before the held slot was fed back in", () => {
    // Positive control for the case above. Without it, "moves once" would read
    // identically whether the fix works or the scroll never churned at all.
    const chosen: Offset[] = [];
    for (let step = 0; step < 40; step++) {
      chosen.push(pickOffset(PORTRAIT, 390, flicker(step)));
    }
    expect(moves(chosen)).toBeGreaterThan(30);
  });

  it("gives the resting spot back once it is clear and the held slot is not", () => {
    // The guard against the opposite failure: a held slot that is never
    // surrendered would ratchet the bubble up the screen a card at a time.
    const held: Offset = { x: 0, y: -LIFT_STEP };
    expect(pickOffset(PORTRAIT, 390, blockSlots(1), held)).toEqual({ x: 0, y: 0 });
  });

  it("never changes side, whichever slots are taken", () => {
    const everySubset = [[0], [0, 1], [0, 1, 2], [0, 1, 2, 3], [0, 1, 2, 3, 4], [1], [2], []];
    let held: Offset | undefined;
    for (const idx of everySubset) {
      held = pickOffset(PORTRAIT, 390, blockSlots(...idx), held);
      expect(held.x).toBe(0);
    }
  });
});
