/**
 * Code-defined product skins. A skin overrides the runtime CSS-variable tokens
 * defined in globals.css (`:root`), scoped to `:root.<product>` so it wins by
 * specificity over the base `:root` light/dark blocks. SSR-injected by app/layout.tsx
 * for the active product (getBrand().skin) — no DB, no FOUC.
 *
 * Atelier = ĒSO/Pontis brand: pearl bg, deep-teal midnight text/primary, bone
 * surfaces, sharp 2px corners. Light-only (the dark/light toggle is skipped for it).
 * Status colors keep the globals.css light defaults; Mabry font, drafting textures,
 * and the laser accent are deferred refinements.
 */

export type SkinKey = "atelier";

export const ATELIER_TOKENS: Record<string, string> = {
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
  "--radius-sm": "2px",
  "--radius": "2px",
  "--radius-md": "2px",
  "--radius-lg": "4px",
  "--sidebar-gradient": "linear-gradient(180deg, #f9f7f4 0%, #edeae2 100%)",
};

/** Emit a token map as a CSS rule scoped to `:root.<rootClass>`. Pure. */
export function skinCss(rootClass: string, tokens: Record<string, string>): string {
  const body = Object.entries(tokens)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
  return `:root.${rootClass} { ${body} }`;
}

/** Precomputed CSS per skin, keyed by SkinKey. */
export const SKIN_CSS: Record<SkinKey, string> = {
  atelier: skinCss("pontis", ATELIER_TOKENS),
};
