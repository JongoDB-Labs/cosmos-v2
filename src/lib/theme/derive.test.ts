import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";
import {
  deriveTint,
  deriveHover,
  themedPrimary,
  readableForeground,
} from "./derive";

describe("derive helpers", () => {
  it("deriveTint returns 12% alpha rgb", () => {
    expect(deriveTint("#7C5CFF")).toMatch(/^rgb\(124 92 255 \/ 0\.12\)$/);
  });

  it("deriveHover darkens the input by ~8% lightness", () => {
    const hover = deriveHover("#7C5CFF");
    // Should be a valid hex color
    expect(hover).toMatch(/^#[0-9A-F]{6}$/);
    // Should differ from the input
    expect(hover).not.toBe("#7C5CFF");
    // Should be darker than input (higher contrast vs white = darker)
    expect(contrastRatio(hover, "#FFFFFF")).toBeGreaterThan(
      contrastRatio("#7C5CFF", "#FFFFFF"),
    );
  });

  describe("themedPrimary (per-theme AA primary)", () => {
    const LIGHT_SURFACE = "#FFFFFF";
    const DARK_SURFACE = "#0B0E1A";

    it("keeps the org colour legible as text on each surface (AA)", () => {
      // blue-500 fails as text on white at full lightness; should be darkened
      // for light and stay legible on dark.
      const { light, dark } = themedPrimary("#3B82F6");
      expect(contrastRatio(light.primary, LIGHT_SURFACE)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(dark.primary, DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
    });

    it("gives each variant a button label that meets AA against it", () => {
      const { light, dark } = themedPrimary("#3B82F6");
      expect(contrastRatio(light.primary, light.foreground)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(dark.primary, dark.foreground)).toBeGreaterThanOrEqual(4.5);
    });

    it("passes non-hex input through unchanged", () => {
      expect(themedPrimary("var(--x)").light.primary).toBe("var(--x)");
    });
  });

  it("readableForeground picks the higher-contrast text colour", () => {
    expect(contrastRatio("#3B82F6", readableForeground("#3B82F6"))).toBeGreaterThanOrEqual(
      contrastRatio("#3B82F6", "#FFFFFF"),
    );
  });
});
