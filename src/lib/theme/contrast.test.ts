import { describe, expect, it } from "vitest";
import { contrastRatio, passesAA } from "./contrast";

describe("contrastRatio", () => {
  it("returns 21 for white on black", () => {
    expect(Math.round(contrastRatio("#FFFFFF", "#000000"))).toBe(21);
  });

  it("returns 1 for same color", () => {
    expect(contrastRatio("#7C5CFF", "#7C5CFF")).toBe(1);
  });
});

describe("passesAA", () => {
  it("Nebula Violet on dark bg passes for large text", () => {
    expect(passesAA("#7C5CFF", "#0B0E1A", "large")).toBe(true);
  });

  it("low-contrast on light bg fails normal text", () => {
    expect(passesAA("#E8EAF2", "#FFFFFF", "normal")).toBe(false);
  });
});
