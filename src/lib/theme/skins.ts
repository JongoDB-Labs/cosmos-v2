/**
 * Code-defined product skins. A skin overrides the runtime CSS-variable tokens
 * from globals.css, scoped to `:root.<product>.<product>` — the class is doubled
 * to raise specificity to 0-3-0 so it beats the base `:root.dark`/`:root.light`
 * blocks (0-2-0) regardless of source order. It ships a matching DARK palette at
 * `:root.<p>.<p>.dark` (0-4-0) so the Light/Dark theme toggle keeps working inside
 * the skin. The skin also carries the things that actually make the look — type
 * (Inter OpenType features), the drafting-grid backdrop, the accent + selection —
 * not just colors. SSR-injected by app/layout.tsx for the active product
 * (getBrand().skin); cosmos (skin=null) emits nothing and is unaffected.
 *
 * Atelier = ĒSO / Pontis brand (ĒSO Brand Guide, Winter 2026): pearl canvas, deep
 * midnight ink, bone surfaces, a faint drafting grid, laser-yellow accent, sharp
 * 2px corners. Light-first; the dark palette inverts to a deep teal-black canvas
 * with pearl ink, keeping the laser accent.
 */

export type SkinKey = "atelier";

/** Atelier light palette — the default. */
export const ATELIER_LIGHT_TOKENS: Record<string, string> = {
  "color-scheme": "light",
  "--bg": "#f9f7f4", // pearl
  "--surface": "#edeae2", // bone
  "--overlay": "#f5f1e8", // cream
  "--border": "rgb(33 65 68 / 0.14)", // midnight hairline
  "--text": "#214144", // midnight
  "--text-muted": "#61655f", // burnt
  "--primary": "#214144", // midnight
  "--primary-hover": "#1a3134", // ink
  "--primary-tint": "rgb(33 65 68 / 0.08)",
  "--primary-foreground": "#f9f7f4", // pearl on midnight
  "--laser": "#e9ff14", // ĒSO acid-yellow accent
  "--radius-sm": "2px",
  "--radius": "2px",
  "--radius-md": "2px",
  "--radius-lg": "4px",
  "--sidebar-gradient": "linear-gradient(180deg, #f9f7f4 0%, #edeae2 100%)",
  // Drafting-paper grid line (midnight on pearl). Rendered on the work-area canvas
  // at 48px — restrained but legibly "graph paper" (pontis-atelier used 0.045).
  "--atelier-grid": "rgb(33 65 68 / 0.10)",
};

/** Atelier dark palette — inverted: deep teal-black canvas, pearl ink, laser accent. */
export const ATELIER_DARK_TOKENS: Record<string, string> = {
  "color-scheme": "dark",
  "--bg": "#16282a", // deep teal-black
  "--surface": "#1f3a3d", // raised midnight
  "--overlay": "#244a4d",
  "--border": "rgb(249 247 244 / 0.16)", // pearl hairline
  "--text": "#f4f1ea", // pearl
  "--text-muted": "#9fb0ab", // muted sage
  "--primary": "#f9f7f4", // pearl actions on dark
  "--primary-hover": "#edeae2",
  "--primary-tint": "rgb(249 247 244 / 0.10)",
  "--primary-foreground": "#16282a",
  "--sidebar-gradient": "linear-gradient(180deg, #1a3134 0%, #16282a 100%)",
  "--atelier-grid": "rgb(249 247 244 / 0.08)",
};

/** Emit `selector { k: v; … }`. Pure. */
function rule(selector: string, tokens: Record<string, string>): string {
  const body = Object.entries(tokens)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
  return `${selector} { ${body} }`;
}

/**
 * Emit a token map scoped to `:root.<rootClass>.<rootClass>` (doubled class →
 * specificity 0-3-0, so it beats the base `:root.dark`/`:root.light`). Pure.
 */
export function skinCss(rootClass: string, tokens: Record<string, string>): string {
  return rule(`:root.${rootClass}.${rootClass}`, tokens);
}

// The ĒSO drafting-paper grid: a 48px midnight grid at low opacity (--atelier-grid).
const GRID_IMAGE =
  "linear-gradient(to right, var(--atelier-grid) 1px, transparent 1px), " +
  "linear-gradient(to bottom, var(--atelier-grid) 1px, transparent 1px)";

/**
 * Full atelier CSS: light + dark token sets, Inter OpenType features, the
 * drafting grid on the transparent app work-area canvas (a `body::before` at
 * z-index:-2 is painted behind the body's own opaque bg and never shows — so the
 * grid lives on the canvas node instead), and laser-yellow selection.
 */
const ATELIER_CSS = [
  skinCss("pontis", ATELIER_LIGHT_TOKENS),
  rule(":root.pontis.pontis.dark", ATELIER_DARK_TOKENS),
  // Inter's stylistic sets give atelier its refined type (Mabry Pro when licensed).
  `:root.pontis { font-feature-settings: "ss01", "cv11", "cv05", "ss03"; font-variant-ligatures: contextual common-ligatures; }`,
  // Clean fixed backdrop. cosmos sets `body::before { background-image: url(/bg-{dark,
  // light}.jpeg) }` (a photo backdrop) — `background-image: none` here overrides it
  // (background-color alone is NOT enough; the photo paints over the color). Together
  // with body::after: none, the atelier canvas stays a plain --bg surface.
  `:root.pontis.pontis body::before { content: ""; position: fixed; inset: 0; z-index: -2; background-color: var(--bg); background-image: none; pointer-events: none; }`,
  `:root.pontis.pontis body::after { content: none; }`,
  // Drafting-paper grid on the app work-area canvas. The shell root [data-app-canvas]
  // is made transparent and carries the 48px grid (var(--atelier-grid) adapts:
  // midnight on pearl in light, pearl on teal-black in dark). Cards + sidebar sit
  // opaque on top, so the grid reads as the drafting texture behind the work area.
  `:root.pontis [data-app-canvas] { background-color: transparent; background-image: ${GRID_IMAGE}; background-size: 48px 48px; }`,
  // Selection reads as a quiet ĒSO accent.
  `:root.pontis ::selection { background: var(--laser); color: #214144; }`,
].join("\n");

/** Precomputed CSS per skin, keyed by SkinKey. */
export const SKIN_CSS: Record<SkinKey, string> = {
  atelier: ATELIER_CSS,
};
