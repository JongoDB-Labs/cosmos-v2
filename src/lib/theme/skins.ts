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

// ── Sector presets (Phase 4): additive look options, sector-tagged for the
//    picker filter. Each owns LOOK tokens only (status colors stay in globals.css).
//    systemFollowsOs:true so "system" theme mode follows the OS, like universe.

const FIELD: SkinPreset = {
  id: "field",
  label: "Field",
  description: "Rugged industrial — concrete, steel ink, safety amber. Built for the field.",
  sectors: ["field", "construction", "ops"],
  systemFollowsOs: true,
  light: {
    "color-scheme": "light",
    "--bg": "#f3f3f1", "--surface": "#e6e6e2", "--overlay": "#fbfbf9",
    "--border": "#cfcfc8", "--text": "#1b1e22", "--text-muted": "#5c6066",
    "--primary": "#ea580c", "--primary-hover": "#c2410c",
    "--primary-tint": "rgb(234 88 12 / 0.10)", "--primary-foreground": "#ffffff",
    "--radius-sm": "3px", "--radius": "4px", "--radius-md": "4px", "--radius-lg": "6px",
    "--sidebar-gradient": "linear-gradient(180deg, #f3f3f1 0%, #e6e6e2 100%)",
  },
  dark: {
    "color-scheme": "dark",
    "--bg": "#17191d", "--surface": "#21242a", "--overlay": "#2a2e35",
    "--border": "#343941", "--text": "#e8e9ea", "--text-muted": "#9aa0a8",
    "--primary": "#f97316", "--primary-hover": "#ea580c",
    "--primary-tint": "rgb(249 115 22 / 0.12)", "--primary-foreground": "#17191d",
    "--radius-sm": "3px", "--radius": "4px", "--radius-md": "4px", "--radius-lg": "6px",
    "--sidebar-gradient": "linear-gradient(180deg, #1b1e22 0%, #17191d 100%)",
  },
  extras: `:root.skin-field { --font-sans: var(--font-field); }
:root.skin-field.skin-field body::before { background-image: none; background-color: var(--bg); }
:root.skin-field.skin-field body::after { content: none; }
:root.skin-field [data-app-canvas] { background-color: transparent; background-image: repeating-linear-gradient(135deg, rgb(234 88 12 / 0.05) 0 7px, transparent 7px 22px); }
:root.skin-field ::selection { background: rgb(234 88 12 / 0.20); }`,
};

const LEDGER: SkinPreset = {
  id: "ledger",
  label: "Ledger",
  description: "Precise finance — deep navy, ink green, tabular figures. Conservative and dense.",
  sectors: ["finance", "accounting"],
  systemFollowsOs: true,
  light: {
    "color-scheme": "light",
    "--bg": "#fbfcfd", "--surface": "#eef2f6", "--overlay": "#ffffff",
    "--border": "#d6dee7", "--text": "#11233f", "--text-muted": "#586a80",
    "--primary": "#15604d", "--primary-hover": "#0f4a3b",
    "--primary-tint": "rgb(21 96 77 / 0.09)", "--primary-foreground": "#ffffff",
    "--radius-sm": "2px", "--radius": "3px", "--radius-md": "3px", "--radius-lg": "5px",
    "--sidebar-gradient": "linear-gradient(180deg, #fbfcfd 0%, #eef2f6 100%)",
  },
  dark: {
    "color-scheme": "dark",
    "--bg": "#0d1626", "--surface": "#15233a", "--overlay": "#1d2f4a",
    "--border": "#263a59", "--text": "#e6ebf2", "--text-muted": "#93a3ba",
    "--primary": "#34d399", "--primary-hover": "#10b981",
    "--primary-tint": "rgb(52 211 153 / 0.12)", "--primary-foreground": "#0d1626",
    "--radius-sm": "2px", "--radius": "3px", "--radius-md": "3px", "--radius-lg": "5px",
    "--sidebar-gradient": "linear-gradient(180deg, #11233f 0%, #0d1626 100%)",
  },
  extras: `:root.skin-ledger { --font-sans: var(--font-ledger); font-feature-settings: "tnum", "lnum"; }
:root.skin-ledger.skin-ledger body::before { background-image: none; background-color: var(--bg); }
:root.skin-ledger.skin-ledger body::after { content: none; }
:root.skin-ledger [data-app-canvas] { background-color: transparent; background-image: repeating-linear-gradient(to bottom, transparent 0 21px, rgb(21 96 77 / 0.08) 21px 22px); }
:root.skin-ledger ::selection { background: rgb(21 96 77 / 0.18); }`,
};

const CLINICAL: SkinPreset = {
  id: "clinical",
  label: "Clinical",
  description: "Calm healthcare — soft teal on white, generous spacing, high legibility.",
  sectors: ["healthcare", "clinical"],
  systemFollowsOs: true,
  light: {
    "color-scheme": "light",
    "--bg": "#ffffff", "--surface": "#eff6f7", "--overlay": "#ffffff",
    "--border": "#d6e6e8", "--text": "#16323a", "--text-muted": "#5d7379",
    "--primary": "#0d9488", "--primary-hover": "#0f766e",
    "--primary-tint": "rgb(13 148 136 / 0.09)", "--primary-foreground": "#ffffff",
    "--radius-sm": "8px", "--radius": "10px", "--radius-md": "10px", "--radius-lg": "14px",
    "--sidebar-gradient": "linear-gradient(180deg, #ffffff 0%, #eff6f7 100%)",
  },
  dark: {
    "color-scheme": "dark",
    "--bg": "#0f1f24", "--surface": "#162e34", "--overlay": "#1d3a42",
    "--border": "#244850", "--text": "#eaf3f4", "--text-muted": "#9bb4b8",
    "--primary": "#2dd4bf", "--primary-hover": "#14b8a6",
    "--primary-tint": "rgb(45 212 191 / 0.12)", "--primary-foreground": "#0f1f24",
    "--radius-sm": "8px", "--radius": "10px", "--radius-md": "10px", "--radius-lg": "14px",
    "--sidebar-gradient": "linear-gradient(180deg, #16323a 0%, #0f1f24 100%)",
  },
  extras: `:root.skin-clinical { --font-sans: var(--font-clinical); }
:root.skin-clinical.skin-clinical body::before { background-image: none; background-color: var(--bg); }
:root.skin-clinical.skin-clinical body::after { content: none; }
:root.skin-clinical [data-app-canvas] { background-color: transparent; background-image: radial-gradient(rgb(13 148 136 / 0.10) 1px, transparent 1px); background-size: 16px 16px; }
:root.skin-clinical ::selection { background: rgb(13 148 136 / 0.18); }`,
};

const STUDIO: SkinPreset = {
  id: "studio",
  label: "Studio",
  description: "Expressive creative — electric violet, airy spacing, modern and bold.",
  sectors: ["design", "creative", "agency"],
  systemFollowsOs: true,
  light: {
    "color-scheme": "light",
    "--bg": "#faf9fb", "--surface": "#f2f1f5", "--overlay": "#ffffff",
    "--border": "#e6e3ec", "--text": "#1a1625", "--text-muted": "#6e6880",
    "--primary": "#7c3aed", "--primary-hover": "#6d28d9",
    "--primary-tint": "rgb(124 58 237 / 0.09)", "--primary-foreground": "#ffffff",
    "--radius-sm": "8px", "--radius": "12px", "--radius-md": "12px", "--radius-lg": "18px",
    "--sidebar-gradient": "linear-gradient(180deg, #faf9fb 0%, #f2f1f5 100%)",
  },
  dark: {
    "color-scheme": "dark",
    "--bg": "#131218", "--surface": "#1c1a24", "--overlay": "#251f33",
    "--border": "#2e2940", "--text": "#f0eef5", "--text-muted": "#a39db5",
    "--primary": "#a78bfa", "--primary-hover": "#8b5cf6",
    "--primary-tint": "rgb(167 139 250 / 0.14)", "--primary-foreground": "#131218",
    "--radius-sm": "8px", "--radius": "12px", "--radius-md": "12px", "--radius-lg": "18px",
    "--sidebar-gradient": "linear-gradient(180deg, #1a1625 0%, #131218 100%)",
  },
  extras: `:root.skin-studio { --font-sans: var(--font-studio); }
:root.skin-studio.skin-studio body::before { background-image: none; background-color: var(--bg); }
:root.skin-studio.skin-studio body::after { content: none; }
:root.skin-studio [data-app-canvas] { background-color: transparent; background-image: radial-gradient(rgb(124 58 237 / 0.08) 2px, transparent 2px); background-size: 28px 28px; }
:root.skin-studio ::selection { background: rgb(124 58 237 / 0.22); }`,
};

export const SKIN_PRESETS: SkinPreset[] = [UNIVERSE, ATELIER, FIELD, LEDGER, CLINICAL, STUDIO];
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
