"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { EventChip } from "./event-chip";
import type { CalendarEvent } from "./month-grid";
import { packWeek } from "@/lib/program-calendar/layout";
import { DAY_MS, utcMidnight } from "@/lib/program-calendar/time";

const HOURS = Array.from({ length: 24 }, (_, i) => i);

/**
 * The Week and Day views: an all-day band above an hour grid.
 *
 * All-day and multi-day events do NOT belong in the hour grid — an exercise
 * running Monday to Friday has no 09:00, and placing it at midnight would bury
 * it above the scroll. They go in the band at the top, packed with the same
 * `packWeek` the month view uses, so a bar that spans Monday to Friday is one
 * element there too.
 *
 * The hour grid positions a timed event by its offset from midnight in the
 * event's OWN zone, not the reader's: a program runs on one clock, and showing
 * an 09:00 IPR at 06:00 because the reader is on the west coast would be
 * actively misleading about when to join.
 */
export function TimeGrid({
  days,
  events,
  onSelect,
}: {
  /** UTC midnights, one per column. Seven for Week, one for Day. */
  days: Date[];
  events: CalendarEvent[];
  onSelect?: (id: string) => void;
}) {
  const from = days[0];
  const allDay = useMemo(() => events.filter((e) => e.allDay || spansDays(e)), [events]);
  const timed = useMemo(() => events.filter((e) => !e.allDay && !spansDays(e)), [events]);
  const band = useMemo(() => packWeek(allDay, from, 3), [allDay, from]);
  const today = utcMidnight(new Date()).getTime();

  const cols = days.length;

  return (
    <div className="min-w-[640px]">
      <div
        className="grid border-b"
        style={{ gridTemplateColumns: `56px repeat(${cols}, minmax(0, 1fr))` }}
      >
        <div className="border-r" />
        {days.map((d) => (
          <div
            key={d.toISOString()}
            className={cn("border-r px-2 py-1.5", d.getTime() === today && "bg-primary/5")}
          >
            <div className="text-[11px] font-semibold tracking-wide text-muted-foreground">
              {new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(d).toUpperCase()}
            </div>
            <div className="text-sm font-semibold tabular-nums">{d.getUTCDate()}</div>
          </div>
        ))}
      </div>

      {/* All-day band */}
      <div
        className="grid border-b"
        style={{ gridTemplateColumns: `56px repeat(${cols}, minmax(0, 1fr))` }}
      >
        <div className="border-r px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          All day
        </div>
        <div
          className="grid"
          style={{
            gridColumn: `2 / span ${cols}`,
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${Math.max(band.laneCount, 1)}, 24px)`,
          }}
        >
          {band.placed.map((p) => (
            <EventChip
              key={p.event.id}
              title={p.event.title}
              category={p.event.category}
              allDay
              continuesBefore={p.continuesBefore}
              continuesAfter={p.continuesAfter}
              onClick={() => onSelect?.(p.event.id)}
              style={{ gridColumn: `${p.startCol} / span ${p.span}`, gridRow: p.lane + 1 }}
            />
          ))}
        </div>
      </div>

      {/* Hour grid */}
      <div className="relative max-h-[60vh] overflow-y-auto">
        <div
          className="grid"
          style={{
            gridTemplateColumns: `56px repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(24, 48px)`,
          }}
        >
          {HOURS.map((h) => (
            <div
              key={`h-${h}`}
              style={{ gridColumn: 1, gridRow: h + 1 }}
              className="border-r border-t px-2 pt-0.5 text-[10px] tabular-nums text-muted-foreground"
            >
              {String(h).padStart(2, "0")}:00
            </div>
          ))}
          {days.map((d, i) =>
            HOURS.map((h) => (
              <div
                key={`c-${i}-${h}`}
                style={{ gridColumn: i + 2, gridRow: h + 1 }}
                className={cn("border-r border-t", d.getTime() === today && "bg-primary/5")}
              />
            )),
          )}

          {timed.map((e) => {
            const col = days.findIndex((d) => sameUtcDay(d, e.startsAt));
            if (col < 0) return null;
            const { top, height } = hourOffsets(e);
            return (
              <div
                key={e.id}
                style={{ gridColumn: col + 2, gridRow: "1 / -1", position: "relative" }}
                className="pointer-events-none"
              >
                <EventChip
                  title={e.title}
                  category={e.category}
                  startsAt={e.startsAt}
                  timeZone={e.timeZone}
                  onClick={() => onSelect?.(e.id)}
                  className="pointer-events-auto absolute left-1 right-1 items-start rounded py-1"
                  style={{ top: `${top}px`, height: `${height}px` }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function spansDays(e: CalendarEvent): boolean {
  return e.endsAt.getTime() - e.startsAt.getTime() > DAY_MS || !sameUtcDay(e.startsAt, e.endsAt);
}

function sameUtcDay(a: Date, b: Date): boolean {
  return utcMidnight(a).getTime() === utcMidnight(b).getTime();
}

/** Pixel offset and height for a timed event, at 48px per hour. Read in the
 *  event's own zone so the grid shows the program's clock. */
function hourOffsets(e: CalendarEvent): { top: number; height: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: e.timeZone || "UTC",
  }).formatToParts(e.startsAt);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const minutes = (e.endsAt.getTime() - e.startsAt.getTime()) / 60000;
  return { top: (hh + mm / 60) * 48, height: Math.max(20, (minutes / 60) * 48) };
}
