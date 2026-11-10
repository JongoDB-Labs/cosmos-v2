/**
 * The categories an org starts with, and how a category becomes a colour.
 *
 * Colours are stored as an rgb TRIPLE plus an alpha rather than a finished CSS
 * string. The reference calendar paints a chip as
 * `linear-gradient(rgba(t,α), rgba(t,α)) #fff` — a tint composited over WHITE —
 * which is correct there because that app is light-only. Cosmos has both
 * themes, so a baked rgba-over-white string would be a white box in dark mode.
 * Keeping the triple lets the chip composite over whatever surface it lands on
 * and lets the text be lifted for dark mode from the same single value.
 */

export interface CategorySeed {
  name: string;
  /** Space-separated rgb channels, e.g. "59 130 246". */
  tintRgb: string;
  tintAlpha: number;
  /** Full-strength text colour for LIGHT mode. */
  textColor: string;
}

/**
 * Nine generic bands to start with. Deliberately NOT one organization's own
 * categories: these ship to every org, and a band named for one customer's
 * internal structure is noise everywhere else. Every one is editable and an
 * org may add its own, which is why they are seed data and not an enum.
 */
export const DEFAULT_CATEGORIES: CategorySeed[] = [
  { name: "Contracts", tintRgb: "52 211 153", tintAlpha: 0.22, textColor: "#065F46" },
  { name: "Deliverables", tintRgb: "245 158 11", tintAlpha: 0.2, textColor: "#92400E" },
  { name: "Engagements", tintRgb: "148 163 184", tintAlpha: 0.28, textColor: "#334155" },
  { name: "Governance & Decisions", tintRgb: "244 114 182", tintAlpha: 0.2, textColor: "#9D174D" },
  { name: "Milestones", tintRgb: "167 139 250", tintAlpha: 0.24, textColor: "#6D28D9" },
  { name: "Business Rhythm", tintRgb: "59 130 246", tintAlpha: 0.18, textColor: "#1D4ED8" },
  // Teal-800, not teal-700 (#0F766E): 700 on this tint measured 4.52:1 on a
  // plain day and 4.16:1 on today's tinted column, under AA. The migration
  // 20261110230000_reviews_demos_chip_ink moves rows already stored with it.
  { name: "Reviews & Demos", tintRgb: "45 212 191", tintAlpha: 0.22, textColor: "#115E59" },
  { name: "Delivery Cadence", tintRgb: "251 113 133", tintAlpha: 0.22, textColor: "#9F1239" },
  { name: "Staffing", tintRgb: "251 146 60", tintAlpha: 0.24, textColor: "#9A3412" },
];

export interface CategoryColors {
  tintRgb: string;
  tintAlpha: number;
  textColor: string;
}

/**
 * The inline style for an event chip.
 *
 * The tint goes on as `rgb(... / α)` so it composites over whatever surface is
 * behind it in either theme, instead of being flattened against white at write
 * time. The text is the stored colour in light mode; in dark mode the chip
 * would be a dark tint under near-black text, so the text is lifted toward
 * white from the SAME triple with `color-mix` — one stored value, both themes,
 * and no second column to drift out of step with the first.
 */
export function chipStyle(c: CategoryColors): React.CSSProperties {
  return {
    backgroundColor: `rgb(${c.tintRgb} / ${c.tintAlpha})`,
    // `--chip-ink` is consumed by the stylesheet, which overrides it under dark
    // mode. Setting `color` directly here would win over any stylesheet rule
    // and make dark mode impossible to fix later without touching every chip.
    ["--chip-ink" as string]: c.textColor,
    ["--chip-tint" as string]: c.tintRgb,
  };
}
