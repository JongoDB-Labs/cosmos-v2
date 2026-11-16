// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrastRatio } from "./contrast";
import { DEFAULT_SKIN_ID, getSkinPreset } from "./skins";

/**
 * Small muted text (`--text-muted`, 10px in the places below) must clear WCAG
 * AA, 4.5:1, on every ground it sits on, in light and dark, in the default skin.
 *
 * The skin, not globals.css, decides the colour at runtime: a skin's look
 * tokens override the :root ones. globals.css had darkened `--text-muted` for
 * this reason, and the default skin kept setting the old #64748B, which axe
 * measured at 4.32:1 on a calendar weekend cell and 3.91:1 on a RAID card chip.
 *
 * Two of the grounds are translucent layers, so they are composited per sRGB
 * channel (alpha over), with the percentages read from the components:
 *   - a calendar weekend cell: `bg-muted/20` over the grid's `bg-border/50`
 *     over the page;
 *   - a RAID card chip: a 12% tint of `--text-muted` itself over the card.
 * The model reproduces axe exactly for the old ink; the first `it` pins that.
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const CALENDAR = read("src/components/boards/calendar/calendar-view.tsx");
const RAID = read("src/components/boards/raid/raid-view.tsx");

function share(src: string, re: RegExp, what: string): number {
  const m = src.match(re);
  if (!m) throw new Error(`could not find ${what}`);
  return Number(m[1]) / 100;
}
const GRID_BORDER = share(CALENDAR, /grid grid-cols-7 gap-px bg-border\/(\d+)/, "the calendar grid's border tint");
const WEEKEND = share(CALENDAR, /isWeekend && "bg-muted\/(\d+)"/, "the calendar weekend cell's tint");
const RAID_TINT = share(
  RAID,
  /bg-\[color-mix\(in_oklab,var\(--text-muted\)_(\d+)%,transparent\)\] text-\[var\(--text-muted\)\]/,
  "the RAID chip's tint",
);

const SKIN = getSkinPreset(DEFAULT_SKIN_ID);
const OLD_LIGHT_INK = "#64748B";

const channels = (h: string) => {
  expect(h, `not a #rrggbb colour: ${h}`).toMatch(/^#[0-9a-f]{6}$/i);
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const toHex = (rgb: number[]) => "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
/** `top` at opacity `a` over `under`, per channel. */
const over = (top: string, a: number, under: string) =>
  toHex(channels(top).map((c, i) => a * c + (1 - a) * channels(under)[i]));

/** Every ground small muted text sits on, named, for one mode's look tokens. */
function grounds(t: Record<string, string>, ink: string): Record<string, string> {
  return {
    "--bg": t["--bg"],
    "--surface": t["--surface"],
    "--overlay": t["--overlay"],
    "calendar day cell": t["--bg"],
    "calendar weekend cell": over(t["--surface"], WEEKEND, over(t["--border"], GRID_BORDER, t["--bg"])),
    "RAID card chip": over(ink, RAID_TINT, t["--surface"]),
  };
}

function hsl(h: string): [number, number, number] {
  const [r, g, b] = channels(h).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const hue = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hue * 60, s, l];
}

describe("muted text contrast in the default skin", () => {
  it("reads the real tints, and the model reproduces axe's measurements of the old light ink", () => {
    expect([GRID_BORDER, WEEKEND, RAID_TINT]).toEqual([0.5, 0.2, 0.12]);
    const g = grounds(SKIN.light, OLD_LIGHT_INK);
    // axe, in Chromium, before this change: #64748b on #f3f4f6 = 4.32 and on #e6e9ee = 3.91.
    expect(g["calendar weekend cell"]).toBe("#f3f4f6");
    expect(g["RAID card chip"]).toBe("#e6e9ee");
    expect(contrastRatio(OLD_LIGHT_INK, g["calendar weekend cell"])).toBeCloseTo(4.32, 2);
    expect(contrastRatio(OLD_LIGHT_INK, g["RAID card chip"])).toBeCloseTo(3.91, 2);
  });

  for (const mode of ["light", "dark"] as const) {
    it(`clears 4.5:1 on every ground in ${mode}`, () => {
      const t = SKIN[mode];
      const ink = t["--text-muted"];
      for (const [where, ground] of Object.entries(grounds(t, ink))) {
        const r = contrastRatio(ink, ground);
        expect(r, `${ink} on ${where} ${ground} (${mode}): ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("keeps the old light colour's hue and saturation, only darker", () => {
    const [h0, s0, l0] = hsl(OLD_LIGHT_INK);
    const [h1, s1, l1] = hsl(SKIN.light["--text-muted"]);
    expect(Math.abs(h1 - h0)).toBeLessThan(1);
    expect(Math.abs(s1 - s0)).toBeLessThan(0.015);
    expect(l1).toBeLessThan(l0);
  });
});
