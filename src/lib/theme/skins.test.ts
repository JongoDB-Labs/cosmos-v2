import { describe, expect, it } from "vitest";
import { ATELIER_LIGHT_TOKENS, ATELIER_DARK_TOKENS, SKIN_CSS, skinCss } from "./skins";

describe("atelier skin", () => {
  it("light palette is pearl/midnight, light, with the laser accent", () => {
    expect(ATELIER_LIGHT_TOKENS["--bg"]).toBe("#f9f7f4");
    expect(ATELIER_LIGHT_TOKENS["--text"]).toBe("#214144");
    expect(ATELIER_LIGHT_TOKENS["--laser"]).toBe("#e9ff14");
    expect(ATELIER_LIGHT_TOKENS["color-scheme"]).toBe("light");
  });

  it("dark palette inverts to a deep canvas with pearl text", () => {
    expect(ATELIER_DARK_TOKENS["color-scheme"]).toBe("dark");
    expect(ATELIER_DARK_TOKENS["--text"]).toBe("#f4f1ea");
    // The dark canvas must differ from the light one (the toggle must do something).
    expect(ATELIER_DARK_TOKENS["--bg"]).not.toBe(ATELIER_LIGHT_TOKENS["--bg"]);
  });

  it("skinCss doubles the class for specificity (beats :root.dark/.light)", () => {
    const css = skinCss("pontis", { "--bg": "#fff", "color-scheme": "light" });
    expect(css).toBe(":root.pontis.pontis { --bg: #fff; color-scheme: light; }");
  });

  it("SKIN_CSS.atelier ships light + dark, type features, the grid, and laser selection", () => {
    const css = SKIN_CSS.atelier;
    expect(css).toContain(":root.pontis.pontis {");
    expect(css).toContain(":root.pontis.pontis.dark {");
    expect(css).toContain("--bg: #f9f7f4;");
    expect(css).toContain('font-feature-settings: "ss01", "cv11", "cv05", "ss03"');
    expect(css).toContain("background-size: 48px 48px;");
    expect(css).toContain("::selection");
  });
});
