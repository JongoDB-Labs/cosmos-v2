/**
 * COSMOS-34: keep the floating agent bubble off the controls it would cover.
 *
 * The bubble is `position: fixed` at the bottom-right, so whatever the page
 * scrolls under it (a card, a link, a form field) becomes untappable. These
 * helpers pick the first slot, from the resting spot outwards, where nothing
 * tappable sits beneath it. They run at every viewport size: an earlier
 * attempt gated this on a phone-width media query and so did nothing on
 * phones turned to landscape, where the viewport is wider than the gate.
 */

export interface Offset {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** What counts as "something the user taps". */
export const TAPPABLE =
  "a[href], button, input, select, textarea, summary, label[for], [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [contenteditable=true]";

/** How far apart the lifted slots are: the bubble's own height plus a gap. */
export const LIFT_STEP = 56;
/** Lifts tried on each side before giving up. */
export const MAX_LIFTS = 4;
/** Gap kept between the bubble and the viewport's edges. */
export const EDGE = 16;

/**
 * The slots to try, nearest first: the resting spot, then lifted in steps;
 * then the same on the left edge. Slots that would leave the viewport are
 * dropped.
 */
export function candidateOffsets(rest: Box, viewportWidth: number): Offset[] {
  const toLeft = -(rest.left - EDGE);
  const out: Offset[] = [];
  for (const x of [0, toLeft]) {
    for (let i = 0; i <= MAX_LIFTS; i++) {
      const y = i === 0 ? 0 : -i * LIFT_STEP;
      if (rest.top + y < EDGE) break;
      if (rest.left + x < 0 || rest.left + x + rest.width > viewportWidth) break;
      out.push({ x, y });
    }
  }
  return out;
}

/** A 3x3 grid of points inside a box, inset so the bubble's soft edges don't count. */
export function samplePoints(box: Box, inset = 4): [number, number][] {
  const xs = [box.left + inset, box.left + box.width / 2, box.left + box.width - inset];
  const ys = [box.top + inset, box.top + box.height / 2, box.top + box.height - inset];
  return xs.flatMap((x) => ys.map((y) => [x, y] as [number, number]));
}

/**
 * The first slot with nothing tappable under it, or the resting spot when
 * every slot is blocked (moving would then just trade one covered control for
 * another). `isBlocked(x, y)` reports whether a tappable element is the
 * topmost thing at that point, ignoring the bubble itself.
 */
export function pickOffset(
  rest: Box,
  viewportWidth: number,
  isBlocked: (x: number, y: number) => boolean,
): Offset {
  for (const o of candidateOffsets(rest, viewportWidth)) {
    const box = { ...rest, left: rest.left + o.x, top: rest.top + o.y };
    if (!samplePoints(box).some(([x, y]) => isBlocked(x, y))) return o;
  }
  return { x: 0, y: 0 };
}

/**
 * `isBlocked` against the live document: the topmost element at the point,
 * skipping the bubble, is (inside) something tappable. Using the hit-test
 * stack rather than overlapping rectangles means anything drawn above the
 * bubble (a dialog, a menu) never counts, and neither does anything hidden
 * under an opaque panel.
 */
export function domIsBlocked(bubble: Element): (x: number, y: number) => boolean {
  return (x, y) => {
    const stack = document.elementsFromPoint(x, y);
    const top = stack.find((el) => el !== bubble && !bubble.contains(el));
    return !!top?.closest(TAPPABLE);
  };
}
