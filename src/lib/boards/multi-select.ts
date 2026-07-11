/**
 * Multi-select math for board surfaces (kanban) — COSMOS-39.
 *
 * The board lets a user pick several cards at once (cmd/ctrl-click to toggle
 * individual cards, shift-click to grab a contiguous range) and then move /
 * assign / delete them together. This module keeps the range calculation PURE
 * so it's unit-testable without rendering a DndContext-wrapped board.
 */

/**
 * Shift-click range selection.
 *
 * @param orderedIds  The currently-visible card ids in on-screen display order
 *                    (columns left-to-right, cards top-to-bottom within each).
 * @param anchorId    The selection anchor — the last card the user toggled with
 *                    a plain / cmd-click. `null` when there's no anchor yet.
 * @param targetId    The shift-clicked card.
 * @param current     The existing selection to extend.
 * @returns A NEW set that unions `current` with every id in the inclusive range
 *          between the anchor and the target. With no usable anchor (null, or
 *          either id not currently visible) it falls back to adding just
 *          `targetId`, so a first-ever shift-click still selects something.
 */
export function selectRange(
  orderedIds: readonly string[],
  anchorId: string | null,
  targetId: string,
  current: ReadonlySet<string>,
): Set<string> {
  const next = new Set(current);
  const to = orderedIds.indexOf(targetId);
  const from = anchorId == null ? -1 : orderedIds.indexOf(anchorId);

  // No valid anchor (or one of the ids scrolled out of the visible set) — treat
  // it as a single add rather than doing nothing.
  if (from === -1 || to === -1) {
    next.add(targetId);
    return next;
  }

  const [lo, hi] = from <= to ? [from, to] : [to, from];
  for (let i = lo; i <= hi; i++) {
    next.add(orderedIds[i]);
  }
  return next;
}
