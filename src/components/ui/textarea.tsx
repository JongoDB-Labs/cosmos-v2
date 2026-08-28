import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * How deep a multi-line input RESTS, in lines of text.
 *
 * A textarea is the control you reach for when the answer is prose — a note, a
 * meeting agenda, a justification. Resting one or two lines deep hides what was
 * just typed, which is the reported defect: "the Notes input box is one line
 * deep … you can not clearly see what has been input, until you go into edit
 * mode". Four lines is a note you can read back while writing it; longer text
 * still grows the field (and then scrolls its container) exactly as before.
 *
 * It takes BOTH mechanisms below, because which one applies is a property of
 * the browser, not of the call site:
 *
 * - `rows` sizes the box everywhere EXCEPT where `field-sizing: content` is
 *   supported — that property sizes the field to its CONTENT and makes the
 *   browser ignore `rows` outright. Every `rows={2}` / `rows={3}` in this
 *   codebase is therefore already a no-op in Chrome today.
 * - So the same four lines are also a `min-height` floor, which is the height a
 *   content-sized (and therefore empty ⇒ one-line) box grows from.
 *
 * A caller may ask for MORE than this; it can never ask for less, because a
 * shallower box is the defect the floor exists to prevent. A caller that needs
 * a compact box on the content-sized path still overrides the floor with its
 * own `min-h-*` class (tailwind-merge keeps the caller's).
 */
export const TEXTAREA_MIN_ROWS = 4

/**
 * The `min-height` a textarea DEEPER than the floor needs, so the content-sized
 * path lands on the same height the `rows` path does. `1lh` is one line box at
 * whatever font size the field inherits; `+ 1rem + 2px` is `py-2` plus the
 * border. At or below the floor there is nothing to add — the base `min-h-24`
 * class already covers it.
 */
export function textareaMinHeight(rows: number): string | undefined {
  return rows > TEXTAREA_MIN_ROWS
    ? `calc(${rows} * 1lh + 1rem + 2px)`
    : undefined
}

function Textarea({
  className,
  rows,
  style,
  ...props
}: React.ComponentProps<"textarea">) {
  const restingRows = Math.max(rows ?? 0, TEXTAREA_MIN_ROWS)

  return (
    <textarea
      data-slot="textarea"
      rows={restingRows}
      style={{ minHeight: textareaMinHeight(restingRows), ...style }}
      className={cn(
        // `min-h-24` (6rem) is TEXTAREA_MIN_ROWS line boxes plus `py-2` at the
        // `md:text-sm` these fields inherit — the resting depth for the
        // `field-sizing: content` path, which ignores `rows`.
        "flex field-sizing-content min-h-24 w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
