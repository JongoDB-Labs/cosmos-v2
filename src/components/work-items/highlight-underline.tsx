"use client";

import { highlightColor, highlightLabel } from "@/lib/work-items/highlights";

/**
 * The card highlight, drawn for an SVG chart.
 *
 * The DOM surfaces recolour the card's border (`highlightStyle`) or the row's
 * left edge (`highlightRowStyle`). Neither channel is available on the two
 * chart surfaces, and both are spoken for by something else:
 *
 *  - **Timeline** reserves a bar's outline explicitly, in a code comment on the
 *    bar itself: "a border here would compete with the outlines that mean
 *    blocked / critical / enabler, which are the only things allowed to change
 *    a bar's edge."
 *  - **Dependency map** uses `stroke` for selected / in-a-cycle, and its 4px
 *    left stripe is already the work-item TYPE colour.
 *
 * So the highlight gets its own channel: a short bar inset along the BOTTOM
 * edge of whatever shape represents the item. Inset rather than sitting below
 * it, so it can never encroach on the next row; the same shape on both charts,
 * so a highlight looks like a highlight wherever you meet it.
 *
 * Renders nothing at all when the item has no highlight — including for a value
 * this build does not recognise, which `highlightColor` narrows to null rather
 * than painting `var(undefined)`.
 */
export function HighlightUnderline({
  highlight,
  x,
  y,
  width,
  height,
  thickness = 3,
}: {
  highlight: string | null | undefined;
  /** Left edge of the shape being marked. */
  x: number;
  /** Top edge of the shape's row. */
  y: number;
  width: number;
  /** Row height — the marker sits inside its bottom edge. */
  height: number;
  thickness?: number;
}) {
  const color = highlightColor(highlight);
  if (!color || width <= 0) return null;
  const label = highlightLabel(highlight);
  return (
    <rect
      x={x}
      y={y + height - thickness}
      width={width}
      height={thickness}
      rx={thickness / 2}
      fill={color}
      // Decorative on its own — the shape it marks already carries the item's
      // name and its own tooltip — but a <title> costs nothing and is the only
      // way the colour's MEANING is available to someone who was not in the
      // meeting where the palette was agreed.
      pointerEvents="none"
      data-highlight={highlight ?? undefined}
    >
      {label ? <title>{label}</title> : null}
    </rect>
  );
}
