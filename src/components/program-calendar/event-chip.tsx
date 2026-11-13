"use client";

import Link from "next/link";
import { CalendarClock, Diamond, Layers, Repeat, Rocket, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CSSProperties } from "react";
import { KIND_LABEL, type OverlayKind } from "@/lib/program-calendar/overlays";

export interface ChipCategory {
  id: string;
  name: string;
  tintRgb: string;
  tintAlpha: number;
  textColor: string;
}

/** The mark each overlay kind leads with, on its chips and in the legend. Program events have none. */
export const KIND_ICON: Record<OverlayKind, LucideIcon> = {
  milestone: Diamond,
  increment: Layers,
  sprint: Repeat,
  release: Rocket,
  due: CalendarClock,
};

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
  kind,
  href,
  description,
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
  /** An overlay record rather than a program event: drawn with its kind's mark
   *  and announced with its kind ("Sprint: ..."). */
  kind?: OverlayKind;
  /** Where the chip leads. A chip with a link is a link, not a button: an
   *  overlay record is edited on its own page, never here. */
  href?: string;
  /** The tooltip, when it should say more than the title. */
  description?: string;
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

  const Icon = kind ? KIND_ICON[kind] : null;
  const classes = cn(
    "pc-chip my-[2px] flex min-w-0 items-center gap-1 px-1.5 text-[11px] font-semibold leading-none",
    "hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
    // A bar that runs past the edge of the week loses its rounding on that
    // side, so the eye reads it as continuing rather than ending here.
    continuesBefore ? "ml-0 rounded-l-none" : "ml-1 rounded-l",
    continuesAfter ? "mr-0 rounded-r-none" : "mr-1 rounded-r",
    className,
  );

  const body = (
    <>
      {continuesBefore ? <span aria-hidden>◂</span> : null}
      {/* The kind is said as well as drawn, so colour and icon are never the
          only way to tell a sprint from a release. */}
      {Icon ? <Icon aria-hidden className="h-3 w-3 shrink-0" /> : null}
      {kind ? <span className="sr-only">{KIND_LABEL[kind]}: </span> : null}
      {/* De-emphasised by WEIGHT, not opacity. `opacity-80` on this ink fades
          it toward the chip tint behind it and drops the pair under AA — axe
          reported it as the one serious violation on this page. Dropping the
          semibold the row inherits reads as secondary without touching
          contrast at all. */}
      {time ? <span className="shrink-0 font-normal tabular-nums">{time}</span> : null}
      <span className="truncate">{title}</span>
      {continuesAfter ? <span className="ml-auto shrink-0" aria-hidden>▸</span> : null}
    </>
  );

  if (href) {
    return (
      // Named outright: built from the sr-only kind and the title, the name
      // came out "Sprint:Sprint 4", the space lost where the two spans meet.
      <Link href={href} title={description ?? title} aria-label={description} style={chipStyle} className={classes}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} title={description ?? title} style={chipStyle} className={classes}>
      {body}
    </button>
  );
}
