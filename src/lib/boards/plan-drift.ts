/**
 * Plan-drift marks for the Timeline / Gantt board.
 *
 * The solid bar is always the ACTUAL span. Each END of the plan is compared with
 * the matching end of the actuals, and any disagreement becomes one mark. Two
 * questions decide how it is drawn, and they are independent:
 *
 *   WHICH COLOUR — is this end ahead of the plan or behind it?
 *     ahead  (earlier than planned) -> GREEN
 *     behind (later  than planned)  -> RED
 *
 *   WHICH STYLE — does the mark land on the bar, or on bare canvas?
 *     Falls straight out of the geometry, because the bar spans the ACTUALS:
 *       started early  -> actual..planned start is INSIDE the bar   -> STRIPED
 *       started late   -> planned..actual start is LEFT of the bar  -> PHANTOM
 *       finished early -> actual..planned end is RIGHT of the bar   -> PHANTOM
 *       finished late  -> planned..actual end is INSIDE the bar     -> STRIPED
 *
 * So: stripe where it overlays real work, shadow where it does not. A solid fill
 * over the bar would paint out the work and read as though the bar stopped
 * short; striping keeps both legible at once.
 *
 * This replaces an amber/green/red scheme in which amber meant "started late"
 * and red meant "finished late" — two different questions sharing one axis, so
 * colour could not be read as ahead-vs-behind. Amber is gone: under the rule
 * above, a late start is simply red on the left.
 *
 * Dates in, dates out — no pixels. The caller maps to x/width with the same
 * projection it uses for the bars, so the marks cannot drift from them.
 */

/** Ahead of plan, or behind it. The only two states a drifted end can be in. */
export type DriftColor = "green" | "red";

/** Whether the mark lies over the solid bar or on bare canvas beside it. */
export type DriftStyle = "striped" | "phantom";

export type DriftEdge = "start" | "end";

export interface DriftMark {
  /** Inclusive left edge. */
  from: Date;
  /** Exclusive right edge. Never before `from`. */
  to: Date;
  color: DriftColor;
  style: DriftStyle;
  edge: DriftEdge;
}

export interface PlanDriftInput {
  plannedStart: Date | null;
  plannedEnd: Date | null;
  actualStart: Date | null;
  /** `completedAt`, or today for something known to be running. */
  actualEnd: Date | null;
}

/**
 * The marks to draw, in PAINT ORDER: phantoms first (they sit on bare canvas and
 * belong behind the bar), then the striped ones, red last so a slip wins wherever
 * two marks meet.
 *
 * Each end is judged on its own. An item with NO actuals at all gets nothing —
 * the planned bar IS the bar then, and a mark of the plan over the plan is just
 * a blur — but a known finish with no recorded start still gets its end mark,
 * because that drift is real and the missing start does not make it less so.
 */
export function planDriftPhantoms(input: PlanDriftInput): DriftMark[] {
  const { plannedStart, plannedEnd, actualStart, actualEnd } = input;
  const phantoms: DriftMark[] = [];
  const striped: DriftMark[] = [];

  // Which span the SOLID bar covers, because that is what decides whether a mark
  // overlays real work. Once an item has started the bar is its actuals; until
  // then the plan IS the bar. Assuming the former is wrong for a ticket with a
  // known finish and no recorded start: its bar sits on the PLANNED dates, so a
  // slip lands beyond it on bare canvas and must be a shadow, while an early
  // finish lands INSIDE it and must be striped — the exact inverse.
  const barStart = actualStart ?? plannedStart;
  const barEnd = actualStart ? actualEnd : plannedEnd;
  const overlapsBar = (from: Date, to: Date): boolean =>
    barStart !== null &&
    barEnd !== null &&
    from.getTime() < barEnd.getTime() &&
    to.getTime() > barStart.getTime();

  /** Stripe where it covers the bar, shadow where it does not. */
  const push = (from: Date, to: Date, color: DriftColor, edge: DriftEdge) => {
    const mark: DriftMark = {
      from,
      to,
      color,
      style: overlapsBar(from, to) ? "striped" : "phantom",
      edge,
    };
    (mark.style === "striped" ? striped : phantoms).push(mark);
  };

  // START. Needs an actual start to compare against — without one there is no
  // second date to draw to, and inventing one would be a lie. Equal dates
  // produce no mark rather than a zero-width sliver.
  if (actualStart && plannedStart) {
    const a = actualStart.getTime();
    const p = plannedStart.getTime();
    // Ahead of plan is green, behind is red. The bar begins at `actualStart`, so
    // an early start lies over its head and a late one sits on bare canvas.
    if (a < p) push(actualStart, plannedStart, "green", "start");
    else if (a > p) push(plannedStart, actualStart, "red", "start");
  }

  // END. Deliberately INDEPENDENT of the start: an item can have a known finish
  // and no recorded start (imported work that predates start capture, or a
  // ticket whose actual_start was cleared in bulk), and its drift is still real.
  //
  // The caller must only pass a REAL end — a completion, or today for something
  // known to be running — never a bare "today" for work that has not started, or
  // every untouched overdue item would sprout a mark it has not earned.
  if (actualEnd && plannedEnd) {
    const a = actualEnd.getTime();
    const p = plannedEnd.getTime();
    if (a > p) push(plannedEnd, actualEnd, "red", "end");
    else if (a < p) push(actualEnd, plannedEnd, "green", "end");
  }

  // Red last within each group, so it wins wherever marks meet.
  const byColor = (m: DriftMark) => (m.color === "red" ? 1 : 0);
  phantoms.sort((x, y) => byColor(x) - byColor(y));
  striped.sort((x, y) => byColor(x) - byColor(y));

  return [...phantoms, ...striped];
}
