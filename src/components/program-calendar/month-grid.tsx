"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { EventChip, type ChipCategory } from "./event-chip";
import { packWeek, weekDays, weeksIn } from "@/lib/program-calendar/layout";
import { DAY_MS, utcMidnight } from "@/lib/program-calendar/time";

export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  timeZone: string;
  category: ChipCategory;
}

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const VISIBLE_LANES = 3;

/**
 * The month view.
 *
 * Each WEEK is its own CSS grid rather than the whole month being one grid:
 * seven columns, a row for the day numbers, three lanes, and a row for the
 * overflow links. That is what lets a multi-day event be a SINGLE element
 * spanning `grid-column: start / span n` — drawn as one continuous bar instead
 * of the title repeating in each cell it touches. A single month-wide grid
 * could not do it, because a bar must never span a week boundary.
 *
 * Everything here reads UTC. The events arrive as instants, and an all-day
 * event is stored as UTC midnight precisely so it lands on the same date for
 * every reader; converting to local time here is what would slide a 30 Nov
 * event back to the 29th for anyone west of UTC.
 */
export function MonthGrid({
  from,
  to,
  month,
  events,
  onSelect,
  onAddOn,
  onShowDay,
}: {
  /** Start of the padded grid window (a Sunday, UTC midnight). */
  from: Date;
  /** End of the padded grid window, exclusive. */
  to: Date;
  /** 0-based UTC month being shown; days outside it are dimmed. */
  month: number;
  events: CalendarEvent[];
  onSelect?: (id: string) => void;
  onAddOn?: (day: Date) => void;
  onShowDay?: (day: Date) => void;
}) {
  const weeks = useMemo(() => weeksIn(from, to), [from, to]);
  const today = utcMidnight(new Date()).getTime();

  return (
    <div className="min-w-[640px]">
      <div className="grid grid-cols-7 border-b bg-muted/30">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground">
            {d}
          </div>
        ))}
      </div>

      {weeks.map((weekStart) => {
        const { placed, overflow, laneCount } = packWeek(events, weekStart, VISIBLE_LANES);
        const days = weekDays(weekStart);
        const lanes = Math.max(laneCount, 1);

        return (
          <div
            key={weekStart.toISOString()}
            className="grid grid-cols-7 border-b"
            style={{ gridTemplateRows: `30px repeat(${lanes}, 24px) 26px` }}
          >
            {/* Column grounds, behind everything, so the cell borders are
                continuous down the whole week rather than stopping under the
                last chip. */}
            {days.map((d, i) => (
              <div
                key={`bg-${d.toISOString()}`}
                style={{ gridColumn: i + 1, gridRow: `1 / -1` }}
                className={cn(
                  "border-r",
                  d.getUTCMonth() !== month && "bg-muted/20",
                  d.getTime() === today && "bg-primary/5",
                )}
              />
            ))}

            {days.map((d, i) => (
              <div
                key={`n-${d.toISOString()}`}
                style={{ gridColumn: i + 1, gridRow: 1 }}
                className="flex items-center justify-between px-2"
              >
                <span
                  className={cn(
                    "text-xs font-semibold tabular-nums",
                    d.getUTCMonth() !== month && "text-muted-foreground",
                    d.getTime() === today &&
                      "flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-primary-foreground",
                  )}
                >
                  {d.getUTCDate() === 1
                    ? `${new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(d)} 1`
                    : d.getUTCDate()}
                </span>
                {onAddOn ? (
                  <button
                    type="button"
                    aria-label={`Add an event on ${d.toISOString().slice(0, 10)}`}
                    onClick={() => onAddOn(d)}
                    className="rounded px-1 text-xs text-muted-foreground opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover:opacity-100 [div:hover>&]:opacity-100"
                  >
                    +
                  </button>
                ) : null}
              </div>
            ))}

            {placed.map((p) => (
              <EventChip
                key={p.event.id}
                title={p.event.title}
                category={p.event.category}
                allDay={p.event.allDay}
                startsAt={p.event.startsAt}
                timeZone={p.event.timeZone}
                continuesBefore={p.continuesBefore}
                continuesAfter={p.continuesAfter}
                onClick={() => onSelect?.(p.event.id)}
                style={{ gridColumn: `${p.startCol} / span ${p.span}`, gridRow: p.lane + 2 }}
              />
            ))}

            {overflow.map((n, i) =>
              n > 0 ? (
                <button
                  key={`o-${i}`}
                  type="button"
                  onClick={() => onShowDay?.(days[i])}
                  style={{ gridColumn: i + 1, gridRow: lanes + 2 }}
                  className="mx-1 truncate rounded px-1 text-left text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  +{n} more
                </button>
              ) : null,
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Rows for the day the user drilled into, used by the overflow popover and
 *  the Day view. Exported so both read the same ordering. */
export function eventsOnDay(events: CalendarEvent[], day: Date): CalendarEvent[] {
  const from = utcMidnight(day).getTime();
  const to = from + DAY_MS;
  return events
    .filter((e) => e.startsAt.getTime() < to && e.endsAt.getTime() > from)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.title.localeCompare(b.title));
}
