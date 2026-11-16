// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrastRatio } from "./contrast";
import { DEFAULT_SKIN_ID, getSkinPreset } from "./skins";

/**
 * Every Badge variant's label must clear WCAG AA (4.5:1; the text is 12px) on
 * every ground a badge sits on, in light and dark.
 *
 * A Badge (components/ui/badge.tsx) is its `--status-<variant>-text` ink on
 * `color-mix(in oklab, <tint> 12%, transparent)`. Mixed with `transparent`,
 * that is the tint itself at 12% opacity, which the browser composites over
 * whatever is behind the badge. So the ground is `0.12 * tint + 0.88 * page`,
 * per sRGB channel, and the model needs no colour-space maths. It reproduces
 * axe exactly: the old blocked ink #B45309 over `--surface` measured 4.37:1 on
 * a #f8eedf ground in Chromium, and the first `it` pins that.
 *
 * The variants come from the tokens themselves (every `--status-*-text`), and
 * the 12% from badge.tsx, so a new variant or a stronger tint is held too.
 */
const ROOT = process.cwd();
const CSS = readFileSync(join(ROOT, "src/app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const BADGE = readFileSync(join(ROOT, "src/components/ui/badge.tsx"), "utf8");

/** Custom properties declared directly in each innermost `<selector> { … }`. */
function blocks(): Array<{ selector: string; vars: Record<string, string> }> {
  return [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    vars: Object.fromEntries([...m[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()])),
  }));
}

/** The one block with this selector that declares the status text tokens. */
function themeBlock(selector: string): Record<string, string> {
  const found = blocks().filter((b) => b.selector === selector && "--status-blocked-text" in b.vars);
  expect(found, `exactly one "${selector}" block declaring --status-blocked-text`).toHaveLength(1);
  return found[0].vars;
}

/**
 * The default skin's look tokens (the grounds and `--text-muted`, which tints
 * the neutral badge) override the :root ones at runtime, so they are layered
 * on top. Status colours stay in globals.css; a skin never sets them.
 */
const SKIN = getSkinPreset(DEFAULT_SKIN_ID);
const look = (t: Record<string, string>) =>
  Object.fromEntries(["--bg", "--surface", "--overlay", "--text-muted"].map((k) => [k, t[k]]));

const ROOT_LIGHT = themeBlock(":root");
const LIGHT = { ...ROOT_LIGHT, ...look(SKIN.light) };
// Dark is declared twice, for the OS preference and for an explicit choice.
const DARK_SYSTEM = { ...ROOT_LIGHT, ...themeBlock(":root:not(.light)"), ...look(SKIN.dark) };
const DARK = { ...ROOT_LIGHT, ...themeBlock(":root.dark"), ...look(SKIN.dark) };

const TINT_PERCENT = Number(BADGE.match(/color-mix\(in oklab, \$\{tint\} (\d+)%, transparent\)/)?.[1]);
const VARIANTS = Object.keys(LIGHT)
  .map((k) => k.match(/^--status-([a-z]+)-text$/)?.[1])
  .filter((v): v is string => !!v);
/** badge.tsx tints `neutral` with --text-muted; every other variant with its own status colour. */
const tintToken = (v: string) => (v === "neutral" ? "--text-muted" : `--status-${v}`);
const GROUNDS = ["--bg", "--surface", "--overlay"];

const channels = (h: string) => {
  expect(h, `not a #rrggbb colour: ${h}`).toMatch(/^#[0-9a-f]{6}$/i);
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const toHex = (rgb: number[]) => "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");

/** The ground a badge paints: its tint at TINT_PERCENT opacity over the page, per channel. */
function badgeGround(vars: Record<string, string>, variant: string, page: string): string {
  const a = TINT_PERCENT / 100;
  const tint = channels(vars[tintToken(variant)]);
  const under = channels(vars[page]);
  return toHex(tint.map((c, i) => a * c + (1 - a) * under[i]));
}
/** The badge's ink against its own ground. */
function badgeRatio(vars: Record<string, string>, variant: string, page: string, ink = vars[`--status-${variant}-text`]) {
  channels(ink);
  return contrastRatio(ink, badgeGround(vars, variant, page));
}

describe("Badge label contrast", () => {
  it("reads the real tokens and the real tint", () => {
    expect(TINT_PERCENT).toBe(12);
    // Positive control: the variants badge.tsx renders are all found.
    expect(VARIANTS).toEqual(
      expect.arrayContaining(["progress", "review", "done", "blocked", "critical", "strategic", "discovery", "neutral"]),
    );
  });

  it("the model reproduces axe's measurement of the old blocked ink", () => {
    expect(badgeGround(LIGHT, "blocked", "--surface")).toBe("#f8eedf");
    expect(badgeRatio(LIGHT, "blocked", "--surface", "#B45309")).toBeCloseTo(4.37, 2);
    expect(badgeRatio(LIGHT, "blocked", "--surface", "#B45309")).toBeLessThan(4.5);
  });

  for (const [theme, vars] of [
    ["light", LIGHT],
    ["dark", DARK],
    ["dark (system)", DARK_SYSTEM],
  ] as const) {
    for (const variant of VARIANTS) {
      it(`${variant} clears 4.5:1 on every ground in ${theme}`, () => {
        for (const ground of GROUNDS) {
          const r = badgeRatio(vars, variant, ground);
          expect(r, `${variant} on ${ground}, ${theme}: ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }

  it("both dark declarations give every badge the same ink", () => {
    for (const v of VARIANTS) {
      expect(DARK_SYSTEM[`--status-${v}-text`], v).toBe(DARK[`--status-${v}-text`]);
    }
  });
});
