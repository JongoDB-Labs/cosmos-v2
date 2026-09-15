import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * How deep a multi-line input rests when its call site expresses NO opinion.
 *
 * A textarea with nothing said about its height is a field for prose — a note,
 * an agenda, a justification. Resting one line deep hides what was just typed,
 * which is the reported defect: "the Notes input box is one line deep … you can
 * not clearly see what has been input, until you go into edit mode". Four lines
 * is a note you can read back while writing it.
 *
 * This is a DEFAULT, never a floor. A call site that asks for a compact box —
 * the retro composer, an inline comment editor — has said something the primitive
 * has no business overriding, and the repo already learned that lesson once: see
 * `notes/editor/sizing.ts`, where "one statically defined huge input box" is
 * itself a bug users reported.
 */
export const TEXTAREA_DEFAULT_ROWS = 4

/**
 * The `min-height` that makes `rows` MEAN something where `field-sizing: content`
 * is supported.
 *
 * Two mechanisms size a textarea, and which one applies is a property of the
 * browser, not of the call site:
 *
 * - `rows` sizes the box everywhere EXCEPT where `field-sizing: content` is
 *   supported — that property sizes the field to its CONTENT and makes the
 *   browser ignore `rows` outright. So every `rows={2}` / `rows={3}` here is
 *   already a no-op in Chrome, where an empty field rests ONE line deep however
 *   many rows it asked for. That is the reported defect, and it is also why
 *   raising `rows` alone would not have fixed it.
 * - Translating the same row count into a `min-height` gives the content-sized
 *   path the height it grows FROM, so both paths land on the depth the call site
 *   actually asked for. Longer text still grows the field and then scrolls,
 *   exactly as before.
 *
 * `1lh` is one line box at whatever font size the field inherits; `+ 1rem + 2px`
 * is `py-2` plus the border.
 */
export function textareaMinHeight(rows: number): string {
  return `calc(${rows} * 1lh + 1rem + 2px)`
}

/**
 * Has the caller set its own height? Then it owns the resting depth on BOTH
 * paths and the primitive adds nothing — no default `rows`, no `min-height`.
 *
 * Checked rather than assumed, because a `min-h-*` class only wins on the
 * content-sized path: leaving a default `rows` on as well would size the box
 * past that class in any browser without `field-sizing`, which is an escape
 * hatch that does not actually let you out.
 */
function callerSetsHeight(
  className: string | undefined,
  style: React.CSSProperties | undefined,
): boolean {
  return /min-h-/.test(className ?? "") || style?.minHeight != null
}

function Textarea({
  className,
  rows,
  style,
  ...props
}: React.ComponentProps<"textarea">) {
  // Precedence, most explicit first: an explicit `rows` is the depth (and is
  // mirrored into `min-height` so the content-sized path honors it too); failing
  // that, a caller's own min-height owns the box untouched; failing that, the
  // default depth applies to both paths.
  const ownHeight = callerSetsHeight(className, style)
  const restingRows = rows ?? (ownHeight ? undefined : TEXTAREA_DEFAULT_ROWS)

  return (
    <textarea
      data-slot="textarea"
      rows={restingRows}
      style={
        restingRows == null
          ? style
          : { minHeight: textareaMinHeight(restingRows), ...style }
      }
      className={cn(
        "flex field-sizing-content w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
