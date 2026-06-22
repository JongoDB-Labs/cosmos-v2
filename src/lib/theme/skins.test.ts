import { describe, expect, it } from "vitest";
import { SKIN_PRESETS, DEFAULT_SKIN_ID, getSkinPreset, allSkinsCss } from "./skins";

describe("skin registry", () => {
  it("ships all presets with unique ids and both modes", () => {
    const ids = SKIN_PRESETS.map((p) => p.id);
    expect(ids).toEqual(["universe", "atelier", "field", "ledger", "clinical", "studio"]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of SKIN_PRESETS) {
      expect(p.light["--bg"]).toBeTruthy();
      expect(p.dark["--bg"]).toBeTruthy();
      expect(p.light["color-scheme"]).toBe("light");
      expect(p.dark["color-scheme"]).toBe("dark");
    }
  });
  it("DEFAULT_SKIN_ID is a real preset; getSkinPreset falls back to it", () => {
    expect(getSkinPreset(DEFAULT_SKIN_ID).id).toBe(DEFAULT_SKIN_ID);
    expect(getSkinPreset("nope").id).toBe(DEFAULT_SKIN_ID);
  });
  it("atelier is the pearl/midnight look with the laser accent + grid", () => {
    const a = getSkinPreset("atelier");
    expect(a.light["--bg"]).toBe("#f9f7f4");
    expect(a.light["--text"]).toBe("#214144");
    expect(a.light["--laser"]).toBe("#e9ff14");
    expect(a.dark["--bg"]).toBe("#16282a");
    expect(a.extras).toContain("[data-app-canvas]");
    expect(a.extras).toContain("background-image: none");
  });
  it("ships the Phase 4 sector presets, tagged + emitting both modes", () => {
    const css = allSkinsCss();
    for (const id of ["field", "ledger", "clinical", "studio"]) {
      const p = getSkinPreset(id);
      expect(p.id).toBe(id);
      expect(p.sectors.length).toBeGreaterThan(0);
      expect(p.light["--primary"]).toBeTruthy();
      expect(p.dark["--primary"]).toBeTruthy();
      expect(css).toContain(`:root.skin-${id}.skin-${id} {`);
      expect(css).toContain(`:root.skin-${id}.skin-${id}.dark {`);
      // systemFollowsOs:true → each emits the OS-follow @media dark variant
      expect(css).toContain(
        `@media (prefers-color-scheme: dark) { :root.skin-${id}.skin-${id}:not(.light):not(.dark) {`,
      );
    }
    expect(getSkinPreset("ledger").extras).toContain('"tnum"');
  });
  it("universe follows the OS in system mode; atelier does not", () => {
    const css = allSkinsCss();
    expect(css).toContain(
      "@media (prefers-color-scheme: dark) { :root.skin-universe.skin-universe:not(.light):not(.dark) {",
    );
    expect(css).not.toContain(":root.skin-atelier.skin-atelier:not(.light):not(.dark)");
  });
  it("allSkinsCss emits doubled-class rules + dark + atelier extras", () => {
    const css = allSkinsCss();
    expect(css).toContain(":root.skin-universe.skin-universe {");
    expect(css).toContain(":root.skin-universe.skin-universe.dark {");
    expect(css).toContain(":root.skin-atelier.skin-atelier {");
    expect(css).toContain(":root.skin-atelier.skin-atelier.dark {");
    expect(css).toContain("background-size: 48px 48px;");
    expect(css).toContain('font-feature-settings: "ss01"');
  });
  it("each sector skin suppresses the cosmos bg, paints a texture, and swaps its font", () => {
    const css = allSkinsCss();
    const fontVar: Record<string, string> = { field: "--font-field", ledger: "--font-ledger", clinical: "--font-clinical", studio: "--font-studio" };
    for (const id of ["field", "ledger", "clinical", "studio"]) {
      expect(css).toContain(`:root.skin-${id}.skin-${id} body::before { background-image: none;`);
      expect(css).toContain(`:root.skin-${id}.skin-${id} body::after { content: none; }`);
      expect(css).toContain(`:root.skin-${id} [data-app-canvas] {`);
      expect(css).toContain(`:root.skin-${id} { --font-sans: var(${fontVar[id]});`);
    }
    // universe keeps the cosmos backdrop (never suppresses it)
    expect(css).not.toContain(":root.skin-universe.skin-universe body::before { background-image: none;");
  });
});
