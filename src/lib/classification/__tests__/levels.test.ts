// src/lib/classification/__tests__/levels.test.ts
//
// Locks the classification metadata to real U.S. Department of War / DoD-IC
// classification policy (see CLASSIFICATION_COLOR_STANDARD for cited sources):
//   • banner/badge colors match the official scheme (RED is reserved for SECRET);
//   • FOUO is retired in favor of CUI (DoDI 5200.48 / 32 CFR 2002).
// These would have caught the original inaccuracy where CONFIDENTIAL rendered RED.
import { describe, it, expect } from "vitest";
import {
  CLASSIFICATION_COLOR_STANDARD,
  CLASSIFICATION_BADGE_COLORS,
  CLASSIFICATION_BANNER_STYLES,
  CLASSIFICATION_LEVELS,
  SELECTABLE_CLASSIFICATION_LEVELS,
  classificationLabel,
  isMarkingLevel,
  type ClassificationLevel,
} from "../levels";

// Tailwind palette tokens that are acceptable for each standard color name.
const PALETTE: Record<string, string[]> = {
  green: ["emerald", "green"],
  purple: ["violet", "purple"],
  blue: ["blue"],
};
// Palettes RESERVED for SECRET/TOP SECRET (above this tool's ceiling): they must
// never appear on any level this tool can actually mark.
const RESERVED_TOKENS = ["red", "rose", "orange", "amber", "yellow"];

// Which standard color each supported (assignable/legacy) level must wear.
const EXPECTED_COLOR: Record<ClassificationLevel, keyof typeof PALETTE> = {
  PUBLIC: "green",
  UNCLASSIFIED: "green",
  FOUO: "purple", // legacy — mirrors CUI
  CUI: "purple",
  CONFIDENTIAL: "blue",
};

describe("classification color standard", () => {
  it("documents the authoritative scheme (RED = SECRET)", () => {
    expect(CLASSIFICATION_COLOR_STANDARD.SECRET.color).toBe("red");
    expect(CLASSIFICATION_COLOR_STANDARD.TOP_SECRET.color).toBe("orange");
    expect(CLASSIFICATION_COLOR_STANDARD.CONFIDENTIAL.color).toBe("blue");
    expect(CLASSIFICATION_COLOR_STANDARD.CUI.color).toBe("purple");
    expect(CLASSIFICATION_COLOR_STANDARD.UNCLASSIFIED.color).toBe("green");
    // Every documented color must cite a source.
    for (const entry of Object.values(CLASSIFICATION_COLOR_STANDARD)) {
      expect(entry.source.length).toBeGreaterThan(0);
    }
  });

  it("colors each level per the standard — and never uses SECRET's red", () => {
    for (const style of [CLASSIFICATION_BANNER_STYLES, CLASSIFICATION_BADGE_COLORS]) {
      for (const [level, cls] of Object.entries(style) as [
        ClassificationLevel,
        string,
      ][]) {
        const expected = PALETTE[EXPECTED_COLOR[level]];
        expect(
          expected.some((tok) => cls.includes(tok)),
          `${level} should use ${EXPECTED_COLOR[level]} (${expected.join("/")}), got: ${cls}`,
        ).toBe(true);
        for (const reserved of RESERVED_TOKENS) {
          expect(
            cls.includes(reserved),
            `${level} must not use "${reserved}" — reserved for SECRET/TOP SECRET`,
          ).toBe(false);
        }
      }
    }
  });
});

describe("FOUO is retired in favor of CUI", () => {
  it("renders legacy FOUO rows AS 'CUI'", () => {
    expect(classificationLabel("FOUO")).toBe("CUI");
  });

  it("excludes FOUO from the assignable picker but keeps CUI", () => {
    const selectable = SELECTABLE_CLASSIFICATION_LEVELS.map((l) => l.value);
    expect(selectable).not.toContain("FOUO");
    expect(selectable).toContain("CUI");
    // FOUO is still a known level (legacy data / marking detector) but not offered.
    expect(CLASSIFICATION_LEVELS.map((l) => l.value)).toContain("FOUO");
  });
});

describe("isMarkingLevel", () => {
  it("marks controlled levels (CUI and above) and skips public/unclassified", () => {
    expect(isMarkingLevel("PUBLIC")).toBe(false);
    expect(isMarkingLevel("UNCLASSIFIED")).toBe(false);
    expect(isMarkingLevel("FOUO")).toBe(true);
    expect(isMarkingLevel("CUI")).toBe(true);
    expect(isMarkingLevel("CONFIDENTIAL")).toBe(true);
  });
});
