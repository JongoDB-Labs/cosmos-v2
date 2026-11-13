"use client";

/**
 * The small pieces every dashboard widget is built from, so twenty-four
 * widgets share one empty state, one caption, one table and one notion of
 * "which day is it".
 */
import { cn } from "@/lib/utils";
import { formatDateShortStable } from "@/lib/format/stable-date";
import type { WidgetProps } from "@/lib/boards/widget-registry";
import type { WidgetItemRow } from "@/lib/boards/widget-data";

/**
 * A widget mounted without board data (the builder's preview) says so rather
 * than drawing a zero. A zero is a claim about the project.
 */
export function NoData({ children = "No data yet" }: { children?: string }) {
  return (
    <div className="flex h-full items-center justify-center text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

/** The one-line note under a tile's title saying what it is showing. */
export function Caption({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block shrink-0 text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * `widget-value-<id>`, so a test can assert THIS tile's number rather than
 * matching a bare digit that also appears in three other tiles.
 */
export function valueTestId(props: WidgetProps): string | undefined {
  const id = props.config.__widgetId;
  return typeof id === "string" ? `widget-value-${id}` : undefined;
}

// ── Days ─────────────────────────────────────────────────────────────────────
//
// Due and start dates are CALENDAR DAYS stored at midnight UTC, so their day
// is the first ten characters of the ISO string — formatting one in the
// reader's zone would show everyone west of UTC the day before. "Today", on
// the other hand, is the reader's own calendar day. Comparing the two as day
// keys (`YYYY-MM-DD`) is what makes "due today" mean today for the person
// looking at the board.

/** `2026-11-12` for a stored calendar date. */
export function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** The reader's own calendar day, as a day key. */
export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );
}

/** The day key `n` days after `key`. */
export function addDays(key: string, n: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** `Nov 12` for a day key, identical on server and client. */
export function formatDay(key: string): string {
  return formatDateShortStable(`${key}T00:00:00Z`);
}

// ── A table of work items ────────────────────────────────────────────────────

export interface ItemColumn {
  label: string;
  cell: (row: WidgetItemRow) => string;
  className?: string;
}

/**
 * The table the Table widget and the AEC registers draw, so all three read
 * alike: sticky header, one row per item, capped with a "Showing n of m".
 */
export function ItemTable({
  rows,
  columns,
  limit,
  empty,
}: {
  rows: WidgetItemRow[];
  columns: ItemColumn[];
  limit: number;
  empty: string;
}) {
  if (rows.length === 0) return <NoData>{empty}</NoData>;
  const shown = rows.slice(0, limit);
  return (
    // Focusable: plain text in an `overflow-auto` box has nothing tabbable in
    // it, which is axe's `scrollable-region-focusable` and genuinely
    // unreachable by keyboard.
    <div className="h-full overflow-auto" tabIndex={0}>
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-background">
          <tr className="border-b">
            {columns.map((c) => (
              <th
                key={c.label}
                scope="col"
                className="px-2 py-1 font-medium text-muted-foreground"
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id} className="border-b last:border-0">
              {columns.map((c) => (
                <td key={c.label} className={cn("px-2 py-1", c.className)}>
                  {c.cell(r) || "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && (
        <p className="px-2 py-1 text-[11px] text-muted-foreground">
          Showing {shown.length} of {rows.length}
        </p>
      )}
    </div>
  );
}

/**
 * Categorical colours for buckets that bring none of their own (an assignee
 * has no colour; a status category and a priority do). Mid-tone, so a slice
 * reads against both the light and the dark card.
 */
export const CATEGORICAL = [
  "#3b82f6",
  "#8b5cf6",
  "#14b8a6",
  "#f59e0b",
  "#ec4899",
  "#84cc16",
  "#06b6d4",
  "#f97316",
  "#6366f1",
  "#64748b",
] as const;

/** The status-category colour token a mark for this row should use. */
export function categoryToken(category: string): string {
  switch (category) {
    case "DONE":
      return "var(--status-done)";
    case "IN_PROGRESS":
      return "var(--status-progress)";
    case "CANCELLED":
      return "var(--text-muted)";
    default:
      return "var(--status-neutral-text)";
  }
}
