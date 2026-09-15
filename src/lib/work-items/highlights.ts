import type { CSSProperties } from "react";

/**
 * Card highlights — a hand-set colour a person puts on a work item to call it
 * out in a meeting ("on track" / "at risk" / "blocked").
 *
 * Deliberately NOT the `Flag` model: flags are org-level state raised and
 * cleared by rules (see `prisma/schema.prisma`, "Nothing here is written by
 * hand"). This is the opposite — nothing computes it, a person sets it, and it
 * means whatever the team says it means in the room.
 *
 * ## Why the keys are colours and the labels are meanings
 *
 * The stored value is the COLOUR (`AMBER`), never the meaning (`AT_RISK`). The
 * colour is the durable half: it is what the reader actually sees, and it is
 * what stays true if a team later renames "At risk" to something else. Naming
 * the column after today's wording would mean a data migration the first time
 * anyone edits a label. Per-org renaming is not built yet; when it is, it lands
 * as a label override on top of these keys and nothing stored has to move.
 *
 * ## Why these particular colours
 *
 * Each maps to a `--status-*-text` custom property from `globals.css`, and every
 * one of those is defined THREE times there — bare `:root`, inside
 * `@media (prefers-color-scheme: dark)`, and on `:root.dark`. So a highlight
 * follows the reader's theme for free, which a stored hex could not: a colour
 * picked against a white card is frequently unreadable on a dark one. The
 * `-text` variants (not the bare `--status-*`) are the ones tuned for contrast
 * against the page rather than for filling a chart segment.
 */
export interface WorkItemHighlightDef {
  /** What this colour is being used to say. Shown in the menu and as a title. */
  readonly label: string;
  /** A `globals.css` custom property, theme-aware in light and dark. */
  readonly cssVar: string;
}

export const WORK_ITEM_HIGHLIGHTS = {
  GREEN: { label: "On track", cssVar: "--status-done-text" },
  AMBER: { label: "At risk", cssVar: "--status-blocked-text" },
  RED: { label: "Blocked", cssVar: "--status-critical-text" },
  BLUE: { label: "Watching", cssVar: "--status-progress-text" },
  PURPLE: { label: "Escalated", cssVar: "--status-discovery-text" },
  GREY: { label: "On hold", cssVar: "--status-neutral-text" },
} as const satisfies Record<string, WorkItemHighlightDef>;

export type WorkItemHighlight = keyof typeof WORK_ITEM_HIGHLIGHTS;

/**
 * Menu / legend order. Explicit rather than `Object.keys`, so the order is a
 * decision (worst-news-last reads badly in a stand-up; on-track first reads as
 * a scale) instead of an accident of object literal order.
 */
export const WORK_ITEM_HIGHLIGHT_ORDER: readonly WorkItemHighlight[] = [
  "GREEN",
  "AMBER",
  "RED",
  "BLUE",
  "PURPLE",
  "GREY",
];

/**
 * Narrow an untrusted value (a DB string, an API body) to a known highlight.
 *
 * The column is a plain nullable TEXT rather than a Postgres enum on purpose:
 * adding a colour should not need a migration, and a row written by an older
 * build carrying a key this build has dropped must degrade to "no highlight"
 * rather than throw on render.
 */
export function isWorkItemHighlight(value: unknown): value is WorkItemHighlight {
  // `Object.hasOwn`, NOT `value in WORK_ITEM_HIGHLIGHTS`: `in` walks the
  // prototype chain, so `"toString"` and `"constructor"` both pass it. That is
  // not theoretical — the guard's whole job is to narrow an arbitrary TEXT
  // column, and `WORK_ITEM_HIGHLIGHTS["toString"]` is a function whose
  // `.cssVar` is `undefined`, which renders as `var(undefined)`.
  return typeof value === "string" && Object.hasOwn(WORK_ITEM_HIGHLIGHTS, value);
}

/** The colour's `var(...)` reference, or null when there is no highlight. */
export function highlightColor(value: unknown): string | null {
  return isWorkItemHighlight(value)
    ? `var(${WORK_ITEM_HIGHLIGHTS[value].cssVar})`
    : null;
}

/** "At risk", or null when there is no highlight. */
export function highlightLabel(value: unknown): string | null {
  return isWorkItemHighlight(value) ? WORK_ITEM_HIGHLIGHTS[value].label : null;
}

/**
 * The inline style that paints the highlight on a card.
 *
 * Returns `undefined` (not `{}`) for an unhighlighted item so callers can spread
 * it unconditionally and React attaches no `style` attribute at all.
 *
 * Two properties, doing two different jobs:
 *
 *  - `borderColor` recolours the border the card ALREADY has. This is the
 *    literal ask — "the highlight should be a border for the card" — and it
 *    costs no layout, because the border box is unchanged.
 *  - `boxShadow` adds a 2px INSET ring in the same colour, which is what makes
 *    a 1px hairline readable across a meeting room. Inset (not a normal ring)
 *    so it paints inside the existing border box: an outer ring on a card that
 *    already has a border reads as a double border, and an outer ring would
 *    also be clipped by the scroll containers the board columns use.
 *
 * Inline style rather than a Tailwind class because the palette lives in CSS
 * custom properties. A `border-[var(--x)]` arbitrary value would work, but only
 * for values Tailwind can see at build time — and it would lose to the
 * `hover:border-primary/50` and `border-primary` utilities already on these
 * cards, which is exactly the specificity fight inline style avoids.
 */
export function highlightStyle(value: unknown): CSSProperties | undefined {
  const color = highlightColor(value);
  if (!color) return undefined;
  return { borderColor: color, boxShadow: `inset 0 0 0 2px ${color}` };
}

/**
 * The same highlight, shaped for a TABLE ROW rather than a card.
 *
 * A row needs its own treatment for two reasons. `box-shadow` on a `<tr>` is
 * unreliable under `border-collapse: collapse` (which Tailwind's preflight sets
 * on every table) because the row may generate no box of its own to paint into.
 * And a full 2px outline around a row that is 100% of the table's width reads as
 * a table gridline, not as a callout.
 *
 * So: a 3px left edge, which is the idiomatic row marker, plus a 12% wash of the
 * same colour so the whole row is scannable — the wash is what makes the
 * highlight findable when you are looking down a list of forty rows rather than
 * at one card. 12% and `color-mix(in oklab, …)` match `ui/stat-card.tsx`, which
 * already tints this way; `transparent` as the second colour keeps whatever
 * zebra-striping or selection background the row already has showing through.
 */
export function highlightRowStyle(value: unknown): CSSProperties | undefined {
  const color = highlightColor(value);
  if (!color) return undefined;
  return {
    borderLeftColor: color,
    borderLeftWidth: 3,
    borderLeftStyle: "solid",
    backgroundColor: `color-mix(in oklab, ${color} 12%, transparent)`,
  };
}
