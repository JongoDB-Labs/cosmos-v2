/**
 * Cumulative flow: how many items sat in each status category at the end of
 * each day (dashboards design §5.2 #18). Pure; extracted from the board's CFD
 * view, which uses it too.
 *
 * With recorded status changes (`Activity` rows for `columnKey`), an item's
 * column on a past day is reconstructed exactly: the value after its last
 * change by then, or, before its first change, that change's `from`. Without
 * them it falls back to the view's original approximation: done once
 * `completedAt` has passed, otherwise its current category (a currently-done
 * item that wasn't done yet counts as in progress).
 */
export type CfdCategory = "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED";
export const CFD_ORDER: readonly CfdCategory[] = ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"];

export interface CfdTransition {
  at: string | Date;
  from: string | null;
  to: string | null;
}

export interface CfdItem {
  createdAt: string | Date;
  completedAt: string | Date | null;
  /** The column the item is in now. */
  columnKey: string;
  /** Its recorded column changes, any order. Omit to approximate. */
  transitions?: CfdTransition[];
}

export interface CfdPoint {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  counts: Partial<Record<CfdCategory, number>>;
}

const t = (v: string | Date) => (v instanceof Date ? v.getTime() : Date.parse(v));

/** The column an item was in at instant `at`, from its transitions. */
export function columnAt(item: CfdItem, at: number): string {
  const changes = (item.transitions ?? []).filter((c) => !Number.isNaN(t(c.at))).sort((a, b) => t(a.at) - t(b.at));
  let col: string | null = null;
  for (const c of changes) {
    if (t(c.at) <= at) col = c.to;
    else {
      // Before its first later change: where that change moved it from.
      if (col === null) col = c.from;
      break;
    }
  }
  return col ?? item.columnKey;
}

export function cumulativeFlow(opts: {
  items: readonly CfdItem[];
  /** The category of a column key (unknown keys count as TODO). */
  category: (columnKey: string) => CfdCategory;
  /** Last day shown. */
  end: Date;
  days: number;
}): { points: CfdPoint[]; categories: CfdCategory[]; exact: boolean } {
  const exact = opts.items.some((i) => (i.transitions?.length ?? 0) > 0);
  const seen = new Set<CfdCategory>();
  const points: CfdPoint[] = [];
  for (let d = opts.days; d >= 0; d--) {
    const day = new Date(Date.UTC(opts.end.getUTCFullYear(), opts.end.getUTCMonth(), opts.end.getUTCDate() - d, 23, 59, 59, 999));
    const at = day.getTime();
    const counts: Partial<Record<CfdCategory, number>> = {};
    for (const item of opts.items) {
      if (t(item.createdAt) > at) continue;
      let cat: CfdCategory;
      if (item.transitions) {
        cat = opts.category(columnAt(item, at));
      } else if (item.completedAt && t(item.completedAt) <= at) {
        cat = "DONE";
      } else {
        const now = opts.category(item.columnKey);
        cat = now === "DONE" ? "IN_PROGRESS" : now;
      }
      counts[cat] = (counts[cat] ?? 0) + 1;
      seen.add(cat);
    }
    points.push({ date: day.toISOString().slice(0, 10), counts });
  }
  return { points, categories: CFD_ORDER.filter((c) => seen.has(c)), exact };
}
