import { describe, expect, it } from "vitest";
import { SKIN_PRESETS, DEFAULT_SKIN_ID, getSkinPreset, allSkinsCss } from "./skins";

describe("skin registry", () => {
  it("ships universe + atelier with unique ids and both modes", () => {
    const ids = SKIN_PRESETS.map((p) => p.id);
    expect(ids).toEqual(["universe", "atelier"]);
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
  it("allSkinsCss emits doubled-class rules + dark + atelier extras", () => {
    const css = allSkinsCss();
    expect(css).toContain(":root.skin-universe.skin-universe {");
    expect(css).toContain(":root.skin-universe.skin-universe.dark {");
    expect(css).toContain(":root.skin-atelier.skin-atelier {");
    expect(css).toContain(":root.skin-atelier.skin-atelier.dark {");
    expect(css).toContain("background-size: 48px 48px;");
    expect(css).toContain('font-feature-settings: "ss01"');
  });
});
