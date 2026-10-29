// COSMOS-234: "when i click into certain drawers or modals on the UI, the cosmo
// agent widget starts darting around the screen at random".
//
// The dodge decision was taken whether or not the bubble was VISIBLE. A docked
// drawer (z-40, later in the DOM) and a dialog (z-50) both paint over it, so
// every candidate slot was hit-tested against the overlay's own controls — a
// drawer is wall-to-wall buttons — and the bubble went hunting for a free spot
// behind a panel it was hidden under. Each mutation inside the overlay picked
// again, and it moved somewhere else.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  domIsCovered,
  isCoveredByStack,
  nextOffset,
  EDGE,
  LIFT_STEP,
  type Box,
  type Offset,
} from "./bubble-dodge";

/** The bubble's resting spot, bottom-right of a 1280x800 desktop viewport. */
const REST: Box = { left: 1208, top: 728, width: 48, height: 48 };
const VIEWPORT = 1280;

describe("isCoveredByStack", () => {
  const bubble = document.createElement("button");
  const icon = document.createElement("svg");
  bubble.appendChild(icon);
  const overlay = document.createElement("aside");

  it("is covered when an overlay is the topmost thing at its centre", () => {
    expect(isCoveredByStack([overlay, bubble], bubble)).toBe(true);
  });

  it("is not covered when the bubble itself is topmost", () => {
    expect(isCoveredByStack([bubble, overlay], bubble)).toBe(false);
  });

  it("is not covered by its own icon", () => {
    // The hit test lands on the <svg> inside the bubble, not the button.
    expect(isCoveredByStack([icon, bubble], bubble)).toBe(false);
  });

  it("is not covered when the point hits nothing at all", () => {
    expect(isCoveredByStack([], bubble)).toBe(false);
  });
});

describe("domIsCovered", () => {
  // jsdom has no layout, so it ships no `elementsFromPoint` at all — the hit
  // test is supplied here, and the bubble is given a box to be measured at.
  type Hittable = { elementsFromPoint?: (x: number, y: number) => Element[] };
  const doc = document as unknown as Hittable;
  const original = doc.elementsFromPoint;
  afterEach(() => {
    doc.elementsFromPoint = original;
  });

  function bubbleAt(box: Box, stackAtCentre: Element[]) {
    const el = document.createElement("button");
    el.getBoundingClientRect = () =>
      ({
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
      }) as DOMRect;
    const elementsFromPoint = vi.fn(() => stackAtCentre);
    doc.elementsFromPoint = elementsFromPoint;
    return { el, elementsFromPoint };
  }

  it("hit-tests the bubble's centre", () => {
    const { el, elementsFromPoint } = bubbleAt(REST, []);
    domIsCovered(el);
    expect(elementsFromPoint).toHaveBeenCalledWith(1232, 752);
  });

  it("reports a drawer painted over the bubble", () => {
    const drawer = document.createElement("aside");
    const { el } = bubbleAt(REST, [drawer]);
    expect(domIsCovered(el)).toBe(true);
  });

  it("reports a bubble nothing is drawn over as uncovered", () => {
    const { el } = bubbleAt(REST, []);
    const page = document.createElement("div");
    doc.elementsFromPoint = () => [el, page];
    expect(domIsCovered(el)).toBe(false);
  });
});

describe("nextOffset", () => {
  it("dodges as before when the bubble is visible", () => {
    const underneath = (_x: number, y: number) => y >= REST.top;
    expect(nextOffset({ x: 0, y: 0 }, false, REST, VIEWPORT, underneath)).toEqual({
      x: 0,
      y: -LIFT_STEP,
    });
  });

  it("holds position while covered, however blocked the page looks", () => {
    // A drawer's composer is under every right-edge slot, so the un-fixed
    // decision was "go to the left edge".
    const held: Offset = { x: 0, y: 0 };
    expect(nextOffset(held, true, REST, VIEWPORT, () => true)).toBe(held);
    expect(nextOffset(held, true, REST, VIEWPORT, (_x, y) => y > 100)).toEqual({ x: 0, y: 0 });
  });

  it("holds a dodge it had already made, rather than resetting under the overlay", () => {
    const applied: Offset = { x: -(REST.left - EDGE), y: 0 };
    expect(nextOffset(applied, true, REST, VIEWPORT, () => false)).toEqual(applied);
  });
});

describe("opening a drawer over the bubble", () => {
  /**
   * The dodge loop as `useDodge` runs it: a check per tick, feeding its own
   * previous answer back in. `blockedOn(tick)` is what the hit test says at
   * that tick — a drawer whose content changes between checks (a message
   * arriving, a list loading) answers differently each time.
   */
  function run(
    covered: boolean,
    blockedOn: (tick: number) => (x: number, y: number) => boolean,
    ticks = 8,
  ) {
    let applied: Offset = { x: 0, y: 0 };
    const chosen: Offset[] = [];
    for (let i = 0; i < ticks; i++) {
      applied = nextOffset(applied, covered, REST, VIEWPORT, blockedOn(i));
      chosen.push(applied);
    }
    return chosen;
  }

  /**
   * A docked drawer covering the whole right edge, with a button that moves as
   * its panel re-renders — so the first clear slot differs tick to tick.
   */
  const drawerContent = (tick: number) => (x: number, y: number) =>
    x >= REST.left - 400 && y >= 200 + ((tick * 97) % 500);

  it("does not move the bubble at all", () => {
    const chosen = run(true, drawerContent);
    expect(new Set(chosen.map((o) => `${o.x},${o.y}`))).toEqual(new Set(["0,0"]));
  });

  it("really would have darted around without the coverage check", () => {
    // Positive control: the same page, decided as if the bubble were visible.
    const chosen = run(false, drawerContent);
    expect(new Set(chosen.map((o) => `${o.x},${o.y}`)).size).toBeGreaterThan(2);
  });
});
