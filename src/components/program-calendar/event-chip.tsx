"use client";

import { cn } from "@/lib/utils";
import type { CSSProperties } from "react";

export interface ChipCategory {
  id: string;
  name: string;
  tintRgb: string;
  tintAlpha: number;
  textColor: string;
}

/**
 * One event on the calendar.
 *
 * The reference calendar paints these as
 * `linear-gradient(rgba(tint,α), rgba(tint,α)) #fff` — a tint flattened
 * against WHITE at render time. That is correct in a light-only app and wrong
 * here: Cosmos has both themes, and a chip whose ground is baked white is a
 * white box on a dark page.
 *
 * So the tint goes on as `rgb(t / α)` and composites over whatever surface is
 * behind it, and the ink travels as a custom property rather than a `color`
 * declaration. An inline `color` would beat any stylesheet rule and leave dark
 * mode unfixable without touching every chip; `--chip-ink` lets the stylesheet
 * lift the text toward white under `prefers-color-scheme: dark` from the same
 * single stored value.
 */
export function EventChip({
  title,
  category,
  continuesBefore,
  continuesAfter,
  allDay,
  startsAt,
  timeZone,
  style,
  className,
  onClick,
}: {
  title: string;
  category: ChipCategory;
  continuesBefore?: boolean;
  continuesAfter?: boolean;
  allDay?: boolean;
  startsAt?: Date;
  timeZone?: string;
  style?: CSSProperties;
  className?: string;
  onClick?: () => void;
}) {
  const chipStyle: CSSProperties = {
    backgroundColor: `rgb(${category.tintRgb} / ${category.tintAlpha})`,
    ["--chip-ink" as string]: category.textColor,
    ["--chip-tint" as string]: category.tintRgb,
    ...style,
  };

  // A timed event leads with its start time, as the reference does. All-day
  // events lead with nothing — the day cell already says which day it is.
  const time =
    !allDay && startsAt
      ? new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: timeZone || "UTC",
        }).format(startsAt)
      : null;

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={chipStyle}
      className={cn(
        "pc-chip my-[2px] flex min-w-0 items-center gap-1 px-1.5 text-[11px] font-semibold leading-none",
        "hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        // A bar that runs past the edge of the week loses its rounding on that
        // side, so the eye reads it as continuing rather than ending here.
        continuesBefore ? "ml-0 rounded-l-none" : "ml-1 rounded-l",
        continuesAfter ? "mr-0 rounded-r-none" : "mr-1 rounded-r",
        className,
      )}
    >
      {continuesBefore ? <span aria-hidden>◂</span> : null}
      {/* De-emphasised by WEIGHT, not opacity. `opacity-80` on this ink fades
          it toward the chip tint behind it and drops the pair under AA — axe
          reported it as the one serious violation on this page. Dropping the
          semibold the row inherits reads as secondary without touching
          contrast at all. */}
      {time ? <span className="shrink-0 font-normal tabular-nums">{time}</span> : null}
      <span className="truncate">{title}</span>
      {continuesAfter ? <span className="ml-auto shrink-0" aria-hidden>▸</span> : null}
    </button>
  );
}
