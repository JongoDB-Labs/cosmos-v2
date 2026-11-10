// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_CATEGORIES } from "./categories";

/**
 * Every default category's chip text must clear WCAG AA (4.5:1, the chips are
 * 11px) on the darkest ground a chip sits on: TODAY's column in the month view,
 * where `bg-primary/5` tints the card.
 *
 * The grounds are what axe measured on the real page in the default skin. In
 * light mode the "+N more" button sits straight on today's column, at #eceef1;
 * in dark mode, #1f2333. The model below composites each tint over those grounds
 * and mixes the dark ink the way `.pc-chip` does in globals.css. It reproduces
 * axe's numbers: 4.16:1 for the old Reviews & Demos ink in light, which is the
 * failure CI caught, and the first `it` pins that. If a skin or theme token
 * moves these grounds, the e2e gate (e2e/a11y.spec.ts, "a11y — program
 * calendar") is the source of truth; this test is the fast, browser-free half.
 */
const TODAY_GROUND = { light: [0xec, 0xee, 0xf1], dark: [0x1f, 0x23, 0x33] } as const;

type Rgb = readonly [number, number, number] | readonly number[];

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const hex = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const tint = (rgb: string): number[] => rgb.split(" ").map(Number);
/** `rgb(t / α)` composited over `ground`. */
const over = (t: number[], alpha: number, ground: Rgb): number[] => t.map((c, i) => alpha * c + (1 - alpha) * ground[i]);
/** Dark-mode ink: `color-mix(in srgb, rgb(tint) 28%, white)`. */
const darkInk = (t: number[]): number[] => t.map((c) => 0.28 * c + 0.72 * 255);

function ratios(c: { tintRgb: string; tintAlpha: number; textColor: string }) {
  const t = tint(c.tintRgb);
  return {
    light: contrast(hex(c.textColor), over(t, c.tintAlpha, TODAY_GROUND.light)),
    dark: contrast(darkInk(t), over(t, c.tintAlpha, TODAY_GROUND.dark)),
  };
}

describe("default event categories: chip contrast on today's column", () => {
  it("the model reproduces axe's measurement of the failure it exists to stop", () => {
    const old = { tintRgb: "45 212 191", tintAlpha: 0.22, textColor: "#0F766E" };
    // To one decimal: axe rounds the composited ground to whole channels.
    expect(ratios(old).light).toBeCloseTo(4.16, 1);
    expect(ratios(old).light).toBeLessThan(4.5);
  });

  for (const c of DEFAULT_CATEGORIES) {
    it(`${c.name} clears 4.5:1 in light and dark`, () => {
      const r = ratios(c);
      expect(r.light, `${c.name} light ${r.light.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      expect(r.dark, `${c.name} dark ${r.dark.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });
  }
});
