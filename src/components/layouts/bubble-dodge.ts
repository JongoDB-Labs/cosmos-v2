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

/**
 * The bubble's RESTING box -- where it would sit with no dodge offset -- from a
 * live measurement, independent of whatever transform is applied to it.
 *
 * `rect` is a `getBoundingClientRect()`, so it already has the current
 * `translate` and `scale` baked in. `layoutWidth`/`layoutHeight` are the
 * untransformed layout size (`offsetWidth`/`offsetHeight`), and `applied` is
 * the dodge offset in force. The position is recovered from the rect's CENTRE
 * rather than its corner: `transform-origin` is the centre, so a scale leaves
 * the centre where it is while moving every corner. Taking the corner instead
 * let `hover:scale-105` shift the resting box by ~1px per axis, enough to move
 * a sample point across a control's edge and flip the chosen slot while the
 * pointer merely rested on the bubble.
 *
 * Note this corrects for SCALE, not for a translate still in flight: a rect
 * measured mid-move is off by the untravelled remainder and no arithmetic here
 * can recover it. That is why the dodge offset is applied without a transition
 * -- see `useDodge` in floating-agent-bubble.tsx.
 */
export function restingBox(
  rect: { left: number; top: number; width: number; height: number },
  layoutWidth: number,
  layoutHeight: number,
  applied: Offset,
): Box {
  const width = layoutWidth || rect.width;
  const height = layoutHeight || rect.height;
  return {
    left: rect.left + rect.width / 2 - width / 2 - applied.x,
    top: rect.top + rect.height / 2 - height / 2 - applied.y,
    width,
    height,
  };
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
 * stack rather than overlapping rectangles means nothing hidden under an
 * opaque panel counts.
 *
 * It says nothing about PAINT ORDER, though: the topmost element at a point is
 * reported whether it sits below the bubble or above it, so an overlay's own
 * controls read as blockers even though the bubble covers nothing there. That
 * is what {@link domIsCovered} is for — ask it first.
 */
export function domIsBlocked(bubble: Element): (x: number, y: number) => boolean {
  return (x, y) => {
    const stack = document.elementsFromPoint(x, y);
    const top = stack.find((el) => el !== bubble && !bubble.contains(el));
    return !!top?.closest(TAPPABLE);
  };
}

/**
 * Is something painted OVER the bubble where it sits — a modal dialog or its
 * backdrop, a sheet, the docked drawer, an open menu?
 *
 * `stack` is a hit test at the bubble's own centre, topmost first, so the
 * bubble is covered exactly when the first entry is neither the bubble nor a
 * part of it (the icon inside it). The centre is the one point the bubble
 * always occupies whatever its corner radius or hover scale.
 */
export function isCoveredByStack(stack: readonly Element[], bubble: Element): boolean {
  const top = stack[0];
  return !!top && top !== bubble && !bubble.contains(top);
}

/** {@link isCoveredByStack} against the live document. */
export function domIsCovered(bubble: Element): boolean {
  const r = bubble.getBoundingClientRect();
  return isCoveredByStack(
    document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2),
    bubble,
  );
}

/**
 * One check of the dodge loop: the offset the bubble should hold now.
 *
 * While it is COVERED the answer is "whatever you are already holding". The
 * bubble hides nothing under a dialog or the docked drawer, so there is
 * nothing to dodge — and re-picking there is actively harmful: every candidate
 * slot is hit-tested against the OVERLAY's controls (a drawer is wall-to-wall
 * buttons), so the right edge reads as blocked, the bubble is sent to the left
 * edge, and the next mutation inside the overlay — a message arriving, a list
 * loading — picks again and sends it somewhere else. Opening certain drawers
 * and modals made it dart across the screen (feedback item 46d8ea78).
 *
 * Holding, rather than resetting to the resting spot, is what makes this safe:
 * a check that moves nothing cannot start a cycle with the next one.
 */
export function nextOffset(
  current: Offset,
  covered: boolean,
  rest: Box,
  viewportWidth: number,
  isBlocked: (x: number, y: number) => boolean,
): Offset {
  if (covered) return current;
  return pickOffset(rest, viewportWidth, isBlocked);
}
