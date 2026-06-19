/**
 * Skin registry. Each preset is a look-token map (light + dark) plus optional
 * extra CSS. All presets emit as doubled-class rules `:root.skin-<id>.skin-<id>{…}`
 * (+ `.dark`), injected once by app/layout.tsx; the active one is chosen by a
 * `skin-<id>` class on <html> (set from the `skin` cookie by the no-FOUC script).
 * A skin owns the LOOK tokens only — semantic `--status-*` colors stay in globals.css.
 */
export type SkinId = string;

export type SkinPreset = {
  id: SkinId;
  label: string;
  description: string;
  sectors: string[];
  motif?: "starfield";
  systemFollowsOs?: boolean;
  light: Record<string, string>;
  dark: Record<string, string>;
  extras?: string;
};

const UNIVERSE: SkinPreset = {
  id: "universe",
  label: "Universe",
  description: "The original cosmos look — deep space, high contrast.",
  sectors: [],
  motif: "starfield",
  systemFollowsOs: true,
  light: {
    "color-scheme": "light",
    "--bg": "#FFFFFF", "--surface": "#F8F9FC", "--overlay": "#FFFFFF",
    "--border": "#E5E7EB", "--text": "#0F172A", "--text-muted": "#64748B",
    "--primary": "#0F172A", "--primary-hover": "#1E293B",
    "--primary-tint": "rgb(15 23 42 / 0.08)", "--primary-foreground": "#FFFFFF",
    "--radius-sm": "4px", "--radius": "6px", "--radius-md": "6px", "--radius-lg": "10px",
    "--sidebar-gradient": "linear-gradient(180deg, rgb(255 255 255 / 0.85) 0%, rgb(248 249 252 / 0.85) 100%)",
  },
  dark: {
    "color-scheme": "dark",
    "--bg": "#0B0E1A", "--surface": "#141828", "--overlay": "#1B2034",
    "--border": "#252B40", "--text": "#E8EAF2", "--text-muted": "#8B8FA8",
    "--primary": "#F8F9FC", "--primary-hover": "#E8EAF2",
    "--primary-tint": "rgb(248 249 252 / 0.10)", "--primary-foreground": "#0F172A",
    "--radius-sm": "4px", "--radius": "6px", "--radius-md": "6px", "--radius-lg": "10px",
    "--sidebar-gradient": "linear-gradient(180deg, rgb(11 14 26 / 0.85) 0%, rgb(19 23 34 / 0.85) 100%)",
  },
};

const ATELIER_LIGHT: Record<string, string> = {
  "color-scheme": "light",
  "--bg": "#f9f7f4", "--surface": "#edeae2", "--overlay": "#f5f1e8",
  "--border": "rgb(33 65 68 / 0.14)", "--text": "#214144", "--text-muted": "#61655f",
  "--primary": "#214144", "--primary-hover": "#1a3134",
  "--primary-tint": "rgb(33 65 68 / 0.08)", "--primary-foreground": "#f9f7f4",
  "--laser": "#e9ff14",
  "--radius-sm": "2px", "--radius": "2px", "--radius-md": "2px", "--radius-lg": "4px",
  "--sidebar-gradient": "linear-gradient(180deg, #f9f7f4 0%, #edeae2 100%)",
  "--atelier-grid": "rgb(33 65 68 / 0.10)",
};
const ATELIER_DARK: Record<string, string> = {
  "color-scheme": "dark",
  "--bg": "#16282a", "--surface": "#1f3a3d", "--overlay": "#244a4d",
  "--border": "rgb(249 247 244 / 0.16)", "--text": "#f4f1ea", "--text-muted": "#9fb0ab",
  "--primary": "#f9f7f4", "--primary-hover": "#edeae2",
  "--primary-tint": "rgb(249 247 244 / 0.10)", "--primary-foreground": "#16282a",
  "--sidebar-gradient": "linear-gradient(180deg, #1a3134 0%, #16282a 100%)",
  "--atelier-grid": "rgb(249 247 244 / 0.08)",
};
const GRID =
  "linear-gradient(to right, var(--atelier-grid) 1px, transparent 1px), " +
  "linear-gradient(to bottom, var(--atelier-grid) 1px, transparent 1px)";
const ATELIER: SkinPreset = {
  id: "atelier", // internal id kept stable (cookies/classes/persisted skinId); display label is "Pontis"
  label: "Pontis",
  description: "Pearl canvas, midnight ink, drafting grid — the architecture studio look.",
  sectors: ["aec"],
  light: ATELIER_LIGHT,
  dark: ATELIER_DARK,
  extras: [
    `:root.skin-atelier { font-feature-settings: "ss01", "cv11", "cv05", "ss03"; font-variant-ligatures: contextual common-ligatures; }`,
    `:root.skin-atelier.skin-atelier body::before { content: ""; position: fixed; inset: 0; z-index: -2; background-color: var(--bg); background-image: none; pointer-events: none; }`,
    `:root.skin-atelier.skin-atelier body::after { content: none; }`,
    `:root.skin-atelier [data-app-canvas] { background-color: transparent; background-image: ${GRID}; background-size: 48px 48px; }`,
    `:root.skin-atelier ::selection { background: var(--laser); color: #214144; }`,
  ].join("\n"),
};

export const SKIN_PRESETS: SkinPreset[] = [UNIVERSE, ATELIER];
export const DEFAULT_SKIN_ID: SkinId = "universe";

export function getSkinPreset(id: string | null | undefined): SkinPreset {
  return SKIN_PRESETS.find((p) => p.id === id) ?? SKIN_PRESETS[0];
}

function block(selector: string, tokens: Record<string, string>): string {
  const body = Object.entries(tokens).map(([k, v]) => `${k}: ${v};`).join(" ");
  return `${selector} { ${body} }`;
}

export function allSkinsCss(): string {
  const out: string[] = [];
  for (const p of SKIN_PRESETS) {
    const root = `:root.skin-${p.id}.skin-${p.id}`;
    out.push(block(root, p.light));
    out.push(block(`${root}.dark`, p.dark));
    if (p.systemFollowsOs) {
      out.push(
        `@media (prefers-color-scheme: dark) { ${block(`${root}:not(.light):not(.dark)`, p.dark)} }`,
      );
    }
    if (p.extras) out.push(p.extras);
  }
  return out.join("\n");
}
