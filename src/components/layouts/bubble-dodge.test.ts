// COSMOS-34: the floating agent bubble must move off whatever tappable control
// it would cover, at every viewport size. Foreman's earlier attempt gated the
// logic on a phone-width media query and so did nothing on phones in
// landscape; these cases use both shapes.
import { describe, it, expect } from "vitest";
import { candidateOffsets, pickOffset, LIFT_STEP, EDGE, type Box } from "./bubble-dodge";

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
