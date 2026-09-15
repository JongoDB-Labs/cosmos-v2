/**
 * How far past its data the Timeline / Gantt axis currently reaches, and when to
 * reach further.
 *
 * The axis used to be a fixed window: the union of every visible item's painted
 * span (see `timeline-span`), plus 3 days before and 7 after. Scrolling stopped
 * dead at those edges, so a plan could not be read against the quarter before it
 * started or the one after it ends, and an empty board offered nowhere at all to
 * look. This module holds the arithmetic for extending that window on demand as
 * the user scrolls — days in, days out, no pixels of chart and no DOM, so the
 * decisions are unit-testable and the view stays a renderer.
 */

/** Extra days the axis renders BEFORE / AFTER the span the items occupy. */
export interface PanWindow {
  before: number;
  after: number;
}

export const NO_PAN: PanWindow = { before: 0, after: 0 };

/**
 * One reach for an edge buys a quarter. Small chunks would fire constantly
 * mid-gesture and each one re-renders the whole chart; large ones would build a
 * lot of axis nobody asked for. A quarter is also the unit people pan a plan in.
 */
export const PAN_CHUNK_DAYS = 90;

/** How close to an edge counts as reaching for it. */
export const PAN_EDGE_PX = 160;

/** What a scroll event knows about where it landed. `previousScrollLeft` is the
 *  offset at the END of the last scroll event, which is what makes the
 *  DIRECTION of travel — and a purely vertical scroll — observable. */
export interface ScrollEdgeMetrics {
  scrollLeft: number;
  previousScrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

/**
 * Which edge, if any, this scroll is reaching for.
 *
 * Direction matters as much as position: the chart and the rows share ONE
 * scroller, so a plain vertical scroll fires this too, and at `scrollLeft === 0`
 * (a board that starts at its left edge, which is most of them) a
 * position-only test would read every wheel-tick down as "extend the past".
 */
export function panIntent(m: ScrollEdgeMetrics): "before" | "after" | null {
  const { scrollLeft, previousScrollLeft, scrollWidth, clientWidth } = m;
  if (scrollLeft === previousScrollLeft) return null;
  if (scrollLeft < previousScrollLeft) {
    return scrollLeft <= PAN_EDGE_PX ? "before" : null;
  }
  return scrollWidth - clientWidth - scrollLeft <= PAN_EDGE_PX ? "after" : null;
}

/** The window one chunk wider on the named side. */
export function grownPan(
  pan: PanWindow,
  side: "before" | "after",
  days: number = PAN_CHUNK_DAYS,
): PanWindow {
  return side === "before"
    ? { before: pan.before + days, after: pan.after }
    : { before: pan.before, after: pan.after + days };
}

/**
 * Days to append so the chart always OVERFLOWS its viewport.
 *
 * Extending on scroll can only help someone who has somewhere to scroll. A
 * three-week board on a wide screen has no horizontal scrollbar at all, so the
 * right-hand edge is unreachable and the future stays invisible — the one case
 * where "scroll right to see more" would otherwise be a no-op. Returns 0 when
 * the viewport cannot be measured (SSR, jsdom, a hidden tab), so an unmeasurable
 * layout never grows the axis.
 *
 * `contentWidth` is the width the caller has DECIDED to draw, not a measured
 * `scrollWidth`: the days this returns widen that number directly, so the next
 * pass is guaranteed to come up short and stop. Feeding it a measurement that
 * the caller's own state has yet to reach would leave the deficit unchanged and
 * the top-up running forever.
 */
export function fillerDays(
  clientWidth: number,
  contentWidth: number,
  dayWidth: number,
): number {
  if (clientWidth <= 0 || dayWidth <= 0) return 0;
  const deficit = clientWidth + PAN_EDGE_PX - contentWidth;
  return deficit > 0 ? Math.ceil(deficit / dayWidth) : 0;
}

/** A half-open `[from, to)` slice of day indices to actually draw. */
export interface DayWindow {
  from: number;
  to: number;
}

export interface DayWindowMetrics {
  /** Scroll offset in CHART coordinates — the scroller's `scrollLeft` less the
   *  width of the sticky work-items column that precedes the chart. */
  scrollLeft: number;
  clientWidth: number;
  dayWidth: number;
  totalDays: number;
}

/**
 * Which day columns are worth putting in the DOM.
 *
 * Every day on the axis costs a `<text>` in the header and, on weekends and
 * Mondays, a `<rect>` or gridline in the body. That was fine for a bounded
 * window and is not fine for one the user can extend forever — pan out a decade
 * and it is thousands of nodes for a viewport that shows thirty.
 *
 * The window is quantised to `PAN_CHUNK_DAYS` with a chunk of slack on each
 * side, for two reasons: the result only CHANGES every ~90 days of travel, so a
 * scroll gesture re-renders the chart rarely rather than every frame; and the
 * slack is far wider than the label column the chart offset ignores, so no
 * rounding at the seam can leave a visible gap.
 *
 * An unmeasurable element (`clientWidth` 0 — SSR, jsdom) renders every day, the
 * behaviour from before there was a window at all.
 */
export function visibleDayWindow(m: DayWindowMetrics): DayWindow {
  const { scrollLeft, clientWidth, dayWidth, totalDays } = m;
  if (clientWidth <= 0 || dayWidth <= 0) return { from: 0, to: totalDays };
  const firstDay = scrollLeft / dayWidth;
  const lastDay = (scrollLeft + clientWidth) / dayWidth;
  const from = Math.max(
    0,
    (Math.floor(firstDay / PAN_CHUNK_DAYS) - 1) * PAN_CHUNK_DAYS,
  );
  const to = Math.min(
    totalDays,
    (Math.ceil(lastDay / PAN_CHUNK_DAYS) + 1) * PAN_CHUNK_DAYS,
  );
  return { from, to };
}

export function sameDayWindow(a: DayWindow, b: DayWindow): boolean {
  return a.from === b.from && a.to === b.to;
}
