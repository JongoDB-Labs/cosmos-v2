import { describe, expect, it } from "vitest";
import { ATELIER_TOKENS, SKIN_CSS, skinCss } from "./skins";

describe("atelier skin", () => {
  it("uses the pearl/midnight palette and is light", () => {
    expect(ATELIER_TOKENS["--bg"]).toBe("#f9f7f4");
    expect(ATELIER_TOKENS["--text"]).toBe("#214144");
    expect(ATELIER_TOKENS["--primary"]).toBe("#214144");
    expect(ATELIER_TOKENS["color-scheme"]).toBe("light");
  });

  it("skinCss scopes tokens to the product root class", () => {
    const css = skinCss("pontis", { "--bg": "#fff", "color-scheme": "light" });
    expect(css).toBe(":root.pontis { --bg: #fff; color-scheme: light; }");
  });

  it("SKIN_CSS.atelier targets :root.pontis with the pearl bg", () => {
    expect(SKIN_CSS.atelier).toContain(":root.pontis {");
    expect(SKIN_CSS.atelier).toContain("--bg: #f9f7f4;");
  });
});
