"use client";

/**
 * The time widgets: a month calendar, a sprint timeline, a compact Gantt and a
 * deadline list — each over the board's filtered work items and the project's
 * sprints, as the board already loaded them.
 *
 * Plain HTML rather than SVG, so a mark's stacking is its DOM order with no
 * paint-order surprises, and every label is real text a screen reader reads.
 */
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WidgetProps } from "@/lib/boards/widget-registry";
import { isWorkItemResolved } from "@/lib/work-items/done-state";
import {
  isClosedRow,
  rowStatusColumns,
  widgetMaxItems,
  type WidgetItemRow,
} from "@/lib/boards/widget-data";
import {
  addDays,
  categoryToken,
  Caption,
  dayKey,
  daysBetween,
  formatDay,
  localDayKey,
  NoData,
} from "./widget-parts";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Percentage position of `key` inside `[start, end]`, clamped to the track. */
function pos(key: string, start: string, span: number): number {
  return Math.min(100, Math.max(0, (daysBetween(start, key) / span) * 100));
}

// ── calendar-widget ──────────────────────────────────────────────────────────

/** Items due on each day key. */
function byDueDay(rows: WidgetItemRow[]): Map<string, WidgetItemRow[]> {
  const out = new Map<string, WidgetItemRow[]>();
  for (const r of rows) {
    if (!r.dueDate) continue;
    const k = dayKey(r.dueDate);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

export function CalendarWidget(props: WidgetProps) {
  const [offset, setOffset] = useState(0);
  const now = useMemo(() => new Date(), []);
  const due = useMemo(() => byDueDay(props.data?.rows ?? []), [props.data]);
  if (!props.data) return <NoData />;

  const month = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const y = month.getFullYear();
  const m = month.getMonth();
  const firstKey = `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const lead = new Date(y, m, 1).getDay();
  const today = localDayKey(now);
  const cells: Array<string | null> = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => addDays(firstKey, i)),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, w) =>
    cells.slice(w * 7, w * 7 + 7),
  );
  const inMonth = [...due.entries()].filter(([k]) => k.startsWith(firstKey.slice(0, 7)));
  const dueCount = inMonth.reduce((n, [, list]) => n + list.length, 0);

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="mb-1 flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => setOffset((o) => o - 1)}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
        </button>
        <span className="font-medium" aria-live="polite">
          {MONTHS[m]} {y}
        </span>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => setOffset((o) => o + 1)}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </button>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {dueCount} due
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" tabIndex={0}>
        <table className="w-full table-fixed border-collapse">
          <caption className="sr-only">
            Work items due in {MONTHS[m]} {y}
          </caption>
          <thead>
            <tr>
              {WEEKDAYS.map((d) => (
                <th
                  key={d}
                  scope="col"
                  className="pb-0.5 text-[10px] font-medium text-muted-foreground"
                >
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week, wi) => (
              <tr key={wi}>
                {week.map((k, di) => {
                  if (!k) return <td key={di} className="border border-[var(--border)]/60" />;
                  const items = due.get(k) ?? [];
                  const open = items.filter((r) => !isClosedRow(r));
                  return (
                    <td
                      key={di}
                      data-day={k}
                      title={items.map((r) => `${r.key} ${r.title}`).join("\n") || undefined}
                      className={cn(
                        "h-7 border border-[var(--border)]/60 px-0.5 align-top",
                        k === today && "bg-[var(--primary-tint)]",
                      )}
                    >
                      <span
                        className={cn(
                          "block text-[10px] leading-tight",
                          k === today ? "font-bold" : "text-muted-foreground",
                        )}
                      >
                        {Number(k.slice(8))}
                      </span>
                      {items.length > 0 && (
                        <span className="flex flex-wrap items-center gap-0.5" aria-hidden>
                          {items.slice(0, 3).map((r) => (
                            <span
                              key={r.id}
                              className="h-1.5 w-1.5 rounded-full"
                              style={{ backgroundColor: categoryToken(r.statusCategory) }}
                            />
                          ))}
                          {items.length > 3 && (
                            <span className="text-[9px] leading-none text-muted-foreground">
                              +{items.length - 3}
                            </span>
                          )}
                        </span>
                      )}
                      {items.length > 0 && (
                        <span className="sr-only">
                          {items.length} due ({open.length} open):{" "}
                          {items.map((r) => r.key).join(", ")}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── timeline-widget ──────────────────────────────────────────────────────────

const TIMELINE_BEFORE = 14;
const TIMELINE_AFTER = 42;
const MAX_LANES = 4;

/**
 * Place each due date in the first lane where it does not crowd the previous
 * marker, so labels do not print over each other. Exported for its test.
 */
export function packLanes<T extends { at: number }>(
  marks: T[],
  minGap: number,
  lanes: number,
): { placed: Array<T & { lane: number }>; overflow: number } {
  const lastAt = Array.from({ length: lanes }, () => -Infinity);
  const placed: Array<T & { lane: number }> = [];
  let overflow = 0;
  for (const mark of [...marks].sort((a, b) => a.at - b.at)) {
    const lane = lastAt.findIndex((x) => mark.at - x >= minGap);
    if (lane === -1) {
      overflow++;
      continue;
    }
    lastAt[lane] = mark.at;
    placed.push({ ...mark, lane });
  }
  return { placed, overflow };
}

export function TimelineWidget(props: WidgetProps) {
  const now = useMemo(() => new Date(), []);
  if (!props.data) return <NoData />;
  const today = localDayKey(now);
  const start = addDays(today, -TIMELINE_BEFORE);
  const end = addDays(today, TIMELINE_AFTER);
  const span = TIMELINE_BEFORE + TIMELINE_AFTER;

  const sprints = props.data.intervals.filter(
    (s) => dayKey(s.endDate) >= start && dayKey(s.startDate) <= end,
  );
  const marks = props.data.rows
    .filter((r) => r.dueDate && dayKey(r.dueDate) >= start && dayKey(r.dueDate) <= end)
    .map((r) => ({ row: r, at: pos(dayKey(r.dueDate!), start, span) }));
  const { placed, overflow } = packLanes(marks, 11, MAX_LANES);
  const ticks = Array.from({ length: Math.floor(span / 7) + 1 }, (_, i) =>
    addDays(start, i * 7),
  );

  if (sprints.length === 0 && marks.length === 0) {
    return <NoData>No sprints or due dates in the next six weeks</NoData>;
  }

  return (
    <div className="flex h-full flex-col text-xs">
      <Caption>
        {formatDay(start)} – {formatDay(end)}
        {overflow > 0 && ` · ${overflow} more due dates not shown`}
      </Caption>
      <div className="relative min-h-0 flex-1" data-testid="timeline-track">
        {/* 1. Sprint bands. */}
        <div className="absolute inset-x-0 top-0 h-5">
          {sprints.map((s) => {
            const left = pos(dayKey(s.startDate), start, span);
            const right = pos(dayKey(s.endDate), start, span);
            return (
              <div
                key={s.id}
                className={cn(
                  "absolute top-0 flex h-5 items-center overflow-hidden rounded border px-1 text-[10px]",
                  s.status === "ACTIVE"
                    ? "border-[var(--status-progress)] bg-[var(--status-progress)]/15 font-medium"
                    : "border-[var(--border)] bg-[var(--surface)] text-muted-foreground",
                )}
                style={{ left: `${left}%`, width: `${Math.max(1, right - left)}%` }}
                title={`${s.name}: ${formatDay(dayKey(s.startDate))} – ${formatDay(dayKey(s.endDate))}`}
              >
                <span className="truncate">{s.name}</span>
              </div>
            );
          })}
        </div>

        {/* 2. Today — after the bands so it shows across them, before the
            markers so a marker due today covers it rather than being cut. */}
        <div
          aria-hidden
          className="absolute bottom-4 top-0 w-px bg-[var(--status-critical)]"
          style={{ left: `${pos(today, start, span)}%` }}
        />

        {/* 3. Due dates, as labelled markers in non-overlapping lanes. */}
        <ul className="absolute inset-x-0 bottom-4 top-6" aria-label="Due dates">
          {placed.map(({ row, at, lane }) => (
            <li
              key={row.id}
              className={cn(
                "absolute flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded border bg-background px-1 font-mono text-[10px]",
                isWorkItemResolved(row, rowStatusColumns(row)) &&
                  "text-muted-foreground line-through",
              )}
              style={{ left: `${at}%`, top: `${lane * 20}px` }}
              title={`${row.key} ${row.title} — due ${formatDay(dayKey(row.dueDate!))}`}
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: categoryToken(row.statusCategory) }}
              />
              {row.key}
              <span className="sr-only">
                {" "}
                {row.title}, due {formatDay(dayKey(row.dueDate!))}
              </span>
            </li>
          ))}
        </ul>

        {/* 4. Week ticks along the bottom. */}
        <div className="absolute inset-x-0 bottom-0 h-4 border-t border-[var(--border)]">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute -translate-x-1/2 text-[9px] text-muted-foreground"
              style={{ left: `${pos(t, start, span)}%` }}
            >
              {formatDay(t)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── gantt ────────────────────────────────────────────────────────────────────

export function GanttWidget(props: WidgetProps) {
  const now = useMemo(() => new Date(), []);
  const limit = widgetMaxItems(props.config, 12);
  if (!props.data) return <NoData />;
  const dated = props.data.rows
    .filter((r) => r.startDate && r.dueDate && dayKey(r.startDate) <= dayKey(r.dueDate))
    .sort((a, b) => dayKey(a.startDate!).localeCompare(dayKey(b.startDate!)));
  const undated = props.data.rows.length - dated.length;
  if (dated.length === 0) {
    return <NoData>No items have both a start and a due date</NoData>;
  }
  const shown = dated.slice(0, limit);
  const today = localDayKey(now);
  const first = shown.reduce((k, r) => (dayKey(r.startDate!) < k ? dayKey(r.startDate!) : k), today);
  const last = shown.reduce((k, r) => (dayKey(r.dueDate!) > k ? dayKey(r.dueDate!) : k), today);
  const start = addDays(first, -1);
  const span = Math.max(1, daysBetween(start, addDays(last, 1)));
  const todayAt = pos(today, start, span);

  return (
    <div className="flex h-full flex-col text-xs">
      <Caption>
        {formatDay(first)} – {formatDay(last)}
        {undated > 0 && ` · ${undated} without both dates not shown`}
      </Caption>
      <div className="min-h-0 flex-1 overflow-auto" tabIndex={0}>
        <ul className="space-y-1" aria-label="Scheduled work items">
          {shown.map((r) => {
            const left = pos(dayKey(r.startDate!), start, span);
            // A one-day item still needs a bar you can see: one day's width.
            const right = pos(addDays(dayKey(r.dueDate!), 1), start, span);
            return (
              <li key={r.id} className="flex items-center gap-2">
                <span className="w-16 shrink-0 truncate font-mono text-muted-foreground">
                  {r.key}
                </span>
                <span className="relative h-4 flex-1 rounded-sm bg-[var(--surface)]">
                  {/* The bar first, the today line after it: an opaque bar
                      drawn later would hide the line on exactly the items in
                      flight today. */}
                  <span
                    className="absolute top-0.5 h-3 rounded-sm"
                    style={{
                      left: `${left}%`,
                      width: `${Math.max(1.5, right - left)}%`,
                      backgroundColor: categoryToken(r.statusCategory),
                    }}
                    title={`${r.key} ${r.title}: ${formatDay(dayKey(r.startDate!))} – ${formatDay(dayKey(r.dueDate!))} · ${r.status}`}
                  />
                  <span
                    aria-hidden
                    className="absolute -top-0.5 h-5 w-px bg-[var(--status-critical)]"
                    style={{ left: `${todayAt}%` }}
                  />
                  <span className="sr-only">
                    {r.title}, {formatDay(dayKey(r.startDate!))} to{" "}
                    {formatDay(dayKey(r.dueDate!))}, {r.status}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
        {dated.length > shown.length && (
          <p className="pt-1 text-[11px] text-muted-foreground">
            Showing {shown.length} of {dated.length}
          </p>
        )}
      </div>
    </div>
  );
}

// ── deadline-list ────────────────────────────────────────────────────────────

/** "3d overdue", "Today", "Tomorrow", "in 5d". */
export function dueLabel(due: string, today: string): string {
  const d = daysBetween(today, due);
  if (d < 0) return `${-d}d overdue`;
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  return `in ${d}d`;
}

export function DeadlineListWidget(props: WidgetProps) {
  const now = useMemo(() => new Date(), []);
  const limit = widgetMaxItems(props.config, 10);
  if (!props.data) return <NoData />;
  const today = localDayKey(now);
  const upcoming = props.data.rows
    .filter((r) => r.dueDate && !isClosedRow(r))
    .sort((a, b) => dayKey(a.dueDate!).localeCompare(dayKey(b.dueDate!)));
  if (upcoming.length === 0) return <NoData>Nothing open has a due date</NoData>;
  const shown = upcoming.slice(0, limit);
  return (
    <div className="h-full overflow-auto" tabIndex={0}>
      <ul className="divide-y text-xs">
        {shown.map((r) => {
          const due = dayKey(r.dueDate!);
          const late = due < today;
          return (
            <li key={r.id} className="flex items-center gap-2 px-1 py-1.5">
              <span className="shrink-0 font-mono text-muted-foreground">{r.key}</span>
              <span className="flex-1 truncate">{r.title}</span>
              <span className="shrink-0 text-muted-foreground">{formatDay(due)}</span>
              <span
                className={cn(
                  "w-20 shrink-0 text-right font-medium",
                  late ? "text-[var(--status-critical-text)]" : "text-muted-foreground",
                )}
              >
                {dueLabel(due, today)}
              </span>
            </li>
          );
        })}
      </ul>
      {upcoming.length > shown.length && (
        <p className="px-1 py-1 text-[11px] text-muted-foreground">
          Showing {shown.length} of {upcoming.length}
        </p>
      )}
    </div>
  );
}
