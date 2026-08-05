import type { OrgBrandOverrides } from "@/lib/brand/resolve";
import { getSkinPreset } from "@/lib/theme/skins";

/**
 * Brand values in a form pdfkit can actually consume.
 *
 * Generated PDFs are the one client-facing surface CSS cannot reach: pdfkit
 * runs server-side with no stylesheet, so a document is only as branded as the
 * values threaded into it. This module is that thread — it turns an org's skin
 * choice into a small set of semantic roles, and is the single place any PDF
 * gets a colour or a font from.
 *
 * Two constraints shape everything here:
 *
 *  1. **A page is white paper.** Skin tokens are authored against `--bg`, not
 *     against white, and only the LIGHT set is even a candidate. A token that
 *     is legible in-app can be near-invisible in print, so the derived ramp is
 *     contrast-checked and degrades to neutral rather than shipping an
 *     unreadable document.
 *
 *  2. **pdfkit silently drops what it cannot parse.** `_normalizeColor`
 *     returns null for every `rgb(...)` form — including the slash-alpha
 *     syntax skins use for borders — and `fillColor(null)` is a no-op that
 *     leaves the previous colour in place. So a bad value does not throw, it
 *     mis-renders. Everything leaving this module goes out as hex.
 */

/** Semantic roles the documents draw with, in descending emphasis. */
export type PdfPalette = {
  /** Headings and key labels. */
  strong: string;
  /** Body copy. */
  body: string;
  /** Secondary/meta text — timestamps, filter summaries. */
  meta: string;
  /** Least prominent — page numbers, overflowed metadata. */
  faint: string;
  /** Hairline rules. */
  rule: string;
  fontRegular: string;
  fontBold: string;
  fontMono: string;
};

/**
 * The unbranded ramp: greyscale, brand-independent, and what every caller that
 * passes no org gets. The neutral/zero-plugin build renders through this and
 * nothing else, so it must stay free of any brand input.
 *
 * Type is pinned to pdfkit's standard-14 fonts. Embedding a real brand typeface
 * needs a TTF/OTF on disk — pdfkit cannot read woff2, which is the only format
 * the app's font pipeline emits — so the typeface stays neutral here until a
 * licensed file exists. Naming the families in one place is still the point:
 * the documents no longer carry font literals of their own.
 */
export const NEUTRAL_PDF_PALETTE: PdfPalette = {
  strong: "black",
  body: "#333",
  meta: "#666",
  faint: "#999",
  rule: "#ccc",
  fontRegular: "Helvetica",
  fontBold: "Helvetica-Bold",
  fontMono: "Courier",
};

/** Body copy has to clear WCAG AA against the page. */
const MIN_BODY_CONTRAST = 4.5;
/** Secondary text is held to the large-text bar. */
const MIN_META_CONTRAST = 3;
/** How far `faint` is lifted toward the page from `meta`. */
const FAINT_LIFT = 0.35;
/** Inline logos are capped by `logoUrlSchema` at ~200KB; bound the decode too. */
const MAX_LOGO_BYTES = 256_000;

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => clamp255(c).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Parse a CSS colour into hex pdfkit will accept, flattening any alpha onto
 * white. Returns null for anything unparseable — callers substitute a neutral
 * rather than handing pdfkit a value it would quietly ignore.
 *
 * Deliberately narrow: hex and rgb()/rgba() only. Modern syntaxes (oklch,
 * color-mix, var()) are not resolvable without a CSS engine, and guessing at
 * them would be worse than falling back.
 */
export function toPdfColor(css: string | null | undefined): string | null {
  if (!css) return null;
  const v = css.trim().toLowerCase();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    return `#${h}`;
  }

  // rgb(r g b / a), rgb(r, g, b), rgba(r, g, b, a) — components may be
  // percentages, and the alpha may itself be a percentage.
  const rgb = /^rgba?\(([^)]+)\)$/.exec(v);
  if (!rgb) return null;
  const parts = rgb[1].replace(/\//g, " ").split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;

  const channel = (raw: string): number | null => {
    const pct = raw.endsWith("%");
    const n = Number.parseFloat(pct ? raw.slice(0, -1) : raw);
    if (!Number.isFinite(n)) return null;
    return pct ? (n / 100) * 255 : n;
  };

  const [r, g, b] = [channel(parts[0]), channel(parts[1]), channel(parts[2])];
  if (r === null || g === null || b === null) return null;

  let alpha = 1;
  if (parts.length === 4) {
    const raw = parts[3];
    const pct = raw.endsWith("%");
    const a = Number.parseFloat(pct ? raw.slice(0, -1) : raw);
    if (!Number.isFinite(a)) return null;
    alpha = Math.max(0, Math.min(1, pct ? a / 100 : a));
  }

  // Composite over white — the page has no alpha channel to preserve it in.
  const over = (c: number) => 255 * (1 - alpha) + c * alpha;
  return toHex(over(r), over(g), over(b));
}

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/** WCAG contrast ratio of a hex colour against the white page. */
function contrastOnWhite(hex: string): number {
  return 1.05 / (relativeLuminance(hex) + 0.05);
}

/** Lift a colour toward the page, for a lower-emphasis step of the same hue. */
function lift(hex: string, amount: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  const up = (c: number) => c + (255 - c) * amount;
  return toHex(up(r), up(g), up(b));
}

/** A parsed token that also clears a legibility bar, else null. */
function legible(css: string | undefined, min: number): string | null {
  const hex = toPdfColor(css);
  if (!hex) return null;
  return contrastOnWhite(hex) >= min ? hex : null;
}

/**
 * Build a palette from a skin's LIGHT token set.
 *
 * All-or-nothing on body copy: if `--text` cannot be read on white, the skin is
 * dark-first and none of its ramp is trustworthy in print, so the whole palette
 * degrades to neutral. Individual secondary roles degrade on their own.
 */
export function derivePdfPalette(lightTokens: Record<string, string>): PdfPalette {
  const body = legible(lightTokens["--text"], MIN_BODY_CONTRAST);
  if (!body) return NEUTRAL_PDF_PALETTE;

  const strong = legible(lightTokens["--primary"], MIN_BODY_CONTRAST) ?? body;
  const meta = legible(lightTokens["--text-muted"], MIN_META_CONTRAST) ?? NEUTRAL_PDF_PALETTE.meta;
  const faint = meta.startsWith("#") ? lift(meta, FAINT_LIFT) : NEUTRAL_PDF_PALETTE.faint;
  const rule = toPdfColor(lightTokens["--border"]) ?? NEUTRAL_PDF_PALETTE.rule;

  return {
    strong,
    body,
    meta,
    faint,
    rule,
    fontRegular: NEUTRAL_PDF_PALETTE.fontRegular,
    fontBold: NEUTRAL_PDF_PALETTE.fontBold,
    fontMono: NEUTRAL_PDF_PALETTE.fontMono,
  };
}

/**
 * The palette for an org's generated documents.
 *
 * An org that has chosen no skin is unbranded and gets the neutral ramp — the
 * absence of `defaultSkinId` is the signal, so a deployment with no branding at
 * all renders exactly as it did before any of this existed. Once a skin IS
 * chosen, `getSkinPreset` owns resolution (including its own fallback for an
 * id we no longer ship) so there is one answer to "which skin is that".
 */
export function resolvePdfPalette(org?: OrgBrandOverrides | null): PdfPalette {
  if (!org?.defaultSkinId) return NEUTRAL_PDF_PALETTE;
  return derivePdfPalette(getSkinPreset(org.defaultSkinId).light);
}

/**
 * An org logo as bytes pdfkit can draw, or null.
 *
 * **Inline data URLs only, by design.** `logoUrl` also accepts an arbitrary
 * http(s) URL, and `image-url.ts` is explicit that it does not screen those for
 * SSRF — it does not need to, because the value is only ever handed to a
 * browser as an `<img src>`. Fetching it here would change that: an org-admin
 * text field would become a server-side request to any address the instance can
 * reach, on an unauthenticated-adjacent export path. A remote logo is therefore
 * skipped, not fetched.
 *
 * PNG and JPEG only — the two formats pdfkit can embed. Anything else (SVG,
 * WebP) would throw mid-document and fail the whole export.
 */
export function resolvePdfLogo(logoUrl?: string | null): Buffer | null {
  if (!logoUrl) return null;
  const m = /^data:image\/(png|jpe?g);base64,([a-z0-9+/=\s]+)$/i.exec(logoUrl.trim());
  if (!m) return null;

  try {
    const raw = m[2].replace(/\s+/g, "");
    const buf = Buffer.from(raw, "base64");
    if (buf.byteLength === 0 || buf.byteLength > MAX_LOGO_BYTES) return null;

    // Buffer.from ignores invalid base64 rather than throwing, so confirm the
    // decode round-trips before handing the bytes to pdfkit.
    if (buf.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")) return null;
    return buf;
  } catch {
    return null;
  }
}

/** Max box an org logo is drawn into, so a large image cannot break layout. */
export const PDF_LOGO_FIT: [number, number] = [120, 36];
