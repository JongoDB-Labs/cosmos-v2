import { contrastRatio } from "./contrast";

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "");
  return [
    parseInt(m.slice(0, 2), 16),
    parseInt(m.slice(2, 4), 16),
    parseInt(m.slice(4, 6), 16),
  ];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return (
    "#" +
    [r, g, b]
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(v)))
          .toString(16)
          .padStart(2, "0")
          .toUpperCase(),
      )
      .join("")
  );
}

function hexToHsl(hex: string): [number, number, number] {
  const [r0, g0, b0] = hexToRgb(hex);
  const r = r0 / 255;
  const g = g0 / 255;
  const b = b0 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hslToHex([h, s, l]: [number, number, number]): string {
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return rgbToHex([r * 255, g * 255, b * 255]);
}

const FG_WHITE = "#FFFFFF";
const FG_DARK = "#0F172A";
const LIGHT_SURFACE = "#FFFFFF";
const DARK_SURFACE = "#0B0E1A";

interface ReadablePrimary {
  primary: string;
  foreground: string;
}

// Whichever of white/dark text contrasts better against `primary` — used for
// the primary button label.
function pickForeground(primary: string): string {
  return contrastRatio(primary, FG_WHITE) >= contrastRatio(primary, FG_DARK)
    ? FG_WHITE
    : FG_DARK;
}

/** Public: the more-legible of white/dark text for an arbitrary background. */
export function readableForeground(hex: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return FG_WHITE;
  return pickForeground(hex);
}

// Adjust the colour's lightness (darker on light surfaces, lighter on dark) until
// it reaches 4.5:1 against `surface`, so the primary is legible when used as
// TEXT (links/accents) on that surface.
function ensureOnSurface(hex: string, surface: string, darken: boolean): string {
  if (contrastRatio(hex, surface) >= 4.5) return hex;
  const [h, s, l] = hexToHsl(hex);
  let lightness = l;
  for (let i = 0; i < 30; i++) {
    lightness = darken
      ? Math.max(0, lightness - 0.03)
      : Math.min(1, lightness + 0.03);
    const candidate = hslToHex([h, s, lightness]);
    if (contrastRatio(candidate, surface) >= 4.5) return candidate;
    if (lightness <= 0 || lightness >= 1) break;
  }
  return hslToHex([h, s, lightness]);
}

/**
 * An org-chosen primary is used both as a button background AND as link/accent
 * text on the page surface — and a single colour can't be legible as text on
 * both a white and a near-black surface. So derive a per-theme pair: darkened
 * for the light surface, lightened for the dark surface, each with the better
 * foreground for button labels. Keeps the org's hue while guaranteeing AA.
 * Non-#rrggbb input is passed through unchanged.
 */
export function themedPrimary(hex: string): {
  light: ReadablePrimary;
  dark: ReadablePrimary;
} {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return {
      light: { primary: hex, foreground: FG_WHITE },
      dark: { primary: hex, foreground: FG_WHITE },
    };
  }
  const light = ensureOnSurface(hex, LIGHT_SURFACE, true);
  const dark = ensureOnSurface(hex, DARK_SURFACE, false);
  return {
    light: { primary: light, foreground: pickForeground(light) },
    dark: { primary: dark, foreground: pickForeground(dark) },
  };
}

export function deriveTint(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgb(${r} ${g} ${b} / 0.12)`;
}

export function deriveHover(hex: string): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex([h, s, Math.max(0, l - 0.08)]);
}
