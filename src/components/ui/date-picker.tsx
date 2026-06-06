"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Design-system date picker — a styled trigger + popover month grid that
 * replaces native <input type="date">, whose browser-default chrome clashed
 * with the rest of the UI (ROOT-6). Values are plain ISO date strings
 * ("YYYY-MM-DD") so it's a drop-in for the old inputs; all date math is done
 * on LOCAL date parts to avoid the classic UTC off-by-one.
 */

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function parseISO(value: string | undefined): Date | null {
  if (!value) return null;
  // Accept a bare date ("2026-05-30") or a full ISO datetime
  // ("2026-05-30T00:00:00.000Z") by reading only the date prefix — callers
  // sometimes hand us a stored datetime, and the old <input type="date">
  // tolerated that too.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

function formatDisplay(d: Date): string {
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export interface DatePickerProps {
  value?: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  clearable?: boolean;
  "aria-label"?: string;
}

export function DatePicker({
  value,
  onValueChange,
  placeholder = "Pick a date",
  className,
  disabled,
  clearable = true,
  "aria-label": ariaLabel,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false);
  const selected = parseISO(value);
  // The month currently shown in the grid; seeds from the value (or today).
  const [view, setView] = React.useState(() => selected ?? new Date());

  // Re-seed the view in the open handler (not an effect) so the grid lands on
  // the selected month each time it opens, even after external value changes.
  function handleOpenChange(next: boolean) {
    if (next) setView(parseISO(value) ?? new Date());
    setOpen(next);
  }

  const year = view.getFullYear();
  const month = view.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();

  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <PopoverPrimitive.Trigger
        data-slot="date-picker-trigger"
        disabled={disabled}
        aria-label={ariaLabel}
        className={cn(
          // No interactive children here: base-ui Trigger renders a real
          // <button>, so a nested clear control would be invalid
          // <button>-in-<button>. Clearing lives in the popover instead.
          "flex h-8 w-full items-center gap-1.5 rounded-lg border border-input bg-transparent px-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
          !selected && "text-muted-foreground",
          className,
        )}
      >
        <CalendarIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">
          {selected ? formatDisplay(selected) : placeholder}
        </span>
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner side="bottom" align="start" sideOffset={4} className="isolate z-50">
          <PopoverPrimitive.Popup
            data-slot="date-picker-popup"
            className="z-50 w-64 origin-(--transform-origin) rounded-lg bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <div className="mb-2 flex items-center justify-between">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => setView(new Date(year, month - 1, 1))}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="text-sm font-medium">
                {MONTHS[month]} {year}
              </span>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => setView(new Date(year, month + 1, 1))}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>

            <div className="mb-1 grid grid-cols-7 gap-0.5 text-center text-[11px] text-muted-foreground">
              {WEEKDAYS.map((w) => (
                <div key={w} className="py-1">{w}</div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-0.5">
              {cells.map((d, i) =>
                d === null ? (
                  <div key={`e${i}`} />
                ) : (
                  <button
                    key={toISO(d)}
                    type="button"
                    aria-label={d.toLocaleDateString(undefined, {
                      weekday: "long",
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    })}
                    aria-current={
                      selected && sameDay(d, selected) ? "date" : undefined
                    }
                    onClick={() => {
                      onValueChange(toISO(d));
                      setOpen(false);
                    }}
                    className={cn(
                      "flex h-8 items-center justify-center rounded-md text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selected && sameDay(d, selected)
                        ? "bg-primary text-primary-foreground hover:bg-primary"
                        : sameDay(d, today)
                          ? "ring-1 ring-inset ring-primary/50"
                          : "",
                    )}
                  >
                    {d.getDate()}
                  </button>
                ),
              )}
            </div>

            {clearable && selected && !disabled && (
              <div className="mt-2 flex justify-end border-t pt-2">
                <button
                  type="button"
                  onClick={() => {
                    onValueChange("");
                    setOpen(false);
                  }}
                  className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Clear
                </button>
              </div>
            )}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
