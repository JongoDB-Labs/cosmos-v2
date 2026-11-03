/**
 * COSMOS-34: keep the floating agent bubble off the controls it would cover.
 *
 * The bubble is `position: fixed` at the bottom-right, so whatever the page
 * scrolls under it (a card, a link, a form field) becomes untappable. These
 * helpers lift it, within its own column, to the nearest slot where nothing
 * tappable sits beneath it. They run at every viewport size: an earlier
 * attempt gated this on a phone-width media query and so did nothing on
 * phones turned to landscape, where the viewport is wider than the gate.
 *
 * Two rules keep the launcher findable, both from feedback item 36938fd0
 * ("kicking the assistant bubble over to the left of the screen, sometimes
 * causing it to jump between places erratically"):
 *
 * 1. It never crosses the viewport. There used to be a second column of slots
 *    on the left edge, taken whenever the right-hand side was full -- which on
 *    a board is most of the time, because a board's right-hand side is cards.
 *    A launcher that changes corners is harder to find than one that sometimes
 *    overlaps a card, so a fully blocked column now simply stays put.
 * 2. The slot it already holds wins ties. The choice used to be recomputed
 *    from scratch on every check, so content scrolling under the corner
 *    re-picked continuously even though each decision was individually
 *    correct. See the `current` argument to {@link pickOffset}.
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
 * The slots to try, nearest first: the resting spot, then lifted in steps, all
 * in the bubble's own column. Slots that would leave the viewport are dropped.
 *
 * `x` is always 0 -- the bubble does not change which side of the screen it is
 * on. The horizontal check is therefore about the resting spot itself: a box
 * already poking past a viewport edge (a transient during a resize) offers no
 * slots at all, and `pickOffset` then leaves the bubble where it is.
 */
export function candidateOffsets(rest: Box, viewportWidth: number): Offset[] {
  if (rest.left < 0 || rest.left + rest.width > viewportWidth) return [];
  const out: Offset[] = [];
  for (let i = 0; i <= MAX_LIFTS; i++) {
    const y = i === 0 ? 0 : -i * LIFT_STEP;
    if (rest.top + y < EDGE) break;
    out.push({ x: 0, y });
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
 * The slot to occupy: the one already held if it is still on offer and still
 * clear, otherwise the nearest clear one, otherwise the resting spot (when
 * every slot is blocked, moving would only trade one covered control for
 * another). `isBlocked(x, y)` reports whether a tappable element is the
 * topmost thing at that point, ignoring the bubble itself.
 *
 * `current` is the offset in force. Passing it is what stops a scrolling board
 * re-picking on every check: without it each decision is made afresh, so the
 * bubble drops back the instant the resting corner clears and lifts again on
 * the next card. Passing a `current` that is no longer among the candidates --
 * a left-edge offset persisted from an older build, say -- is safe: it is
 * ignored, so a stale value cannot pin the bubble off to one side forever.
 */
export function pickOffset(
  rest: Box,
  viewportWidth: number,
  isBlocked: (x: number, y: number) => boolean,
  current?: Offset,
): Offset {
  const slots = candidateOffsets(rest, viewportWidth);
  const isClear = (o: Offset) => {
    const box = { ...rest, left: rest.left + o.x, top: rest.top + o.y };
    return !samplePoints(box).some(([x, y]) => isBlocked(x, y));
  };
  const held = current && slots.some((o) => o.x === current.x && o.y === current.y);
  if (held && isClear(current)) return current;
  for (const o of slots) if (isClear(o)) return o;
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
