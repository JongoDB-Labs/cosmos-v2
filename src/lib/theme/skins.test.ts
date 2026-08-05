import { describe, expect, it } from "vitest";
import { SKIN_PRESETS, DEFAULT_SKIN_ID, getSkinPreset, allSkinsCss } from "./skins";
import { contrastRatio, passesAA } from "./contrast";

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
  it("atelier carries all six brand-guide colour tokens in both modes", () => {
    // Presence only — the clay pair's values are asserted separately below.
    const a = getSkinPreset("atelier");
    for (const mode of ["light", "dark"] as const) {
      for (const token of ["--bg", "--surface", "--text", "--laser", "--clay", "--clay-burnt"]) {
        expect(a[mode][token], `${mode} is missing ${token}`).toBeTruthy();
      }
    }
  });
  it("light carries the clay pair exactly as the frozen brand guide defines it", () => {
    // PMS 404 C and PMS 2336 C. These are warm grey-greens; an earlier
    // placeholder pair guessed terracotta and was wrong on both.
    const a = getSkinPreset("atelier");
    expect(a.light["--clay"]).toBe("#828279");
    expect(a.light["--clay-burnt"]).toBe("#61655f");
  });
  it("both clay tokens stay legible on their own canvas", () => {
    // Light carries the brand values verbatim; they are accent weights (3.6:1
    // and 5.6:1), so the bar there is AA-large. Dark carries lifted derivatives
    // held to full AA, because BURNT CLAY verbatim is 2.6:1 on that canvas —
    // below even the large bar. The guide defines no dark-mode variant.
    const a = getSkinPreset("atelier");
    for (const t of ["--clay", "--clay-burnt"]) {
      expect(passesAA(a.light[t], a.light["--bg"], "large"), `light ${t}`).toBe(true);
      expect(passesAA(a.dark[t], a.dark["--bg"]), `dark ${t}`).toBe(true);
    }
  });
  it("keeps clay lighter than burnt clay in both modes", () => {
    // The dark pair is derived by lifting BOTH by the same factor precisely so
    // this ordering survives. Lifting each only as far as it individually
    // needed to clear AA collapsed them onto the same colour.
    const a = getSkinPreset("atelier");
    for (const mode of ["light", "dark"] as const) {
      expect(a[mode]["--clay"]).not.toBe(a[mode]["--clay-burnt"]);
      expect(
        contrastRatio(a[mode]["--clay"], "#000000"),
        `${mode}: clay should be the lighter of the pair`,
      ).toBeGreaterThan(contrastRatio(a[mode]["--clay-burnt"], "#000000"));
    }
  });
  it("every var ::selection references is defined in both modes", () => {
    // Regression: --laser was light-only while ::selection used it unconditionally,
    // so dark-mode selection painted the hardcoded midnight text over an undefined
    // background — dark on dark. Assert the general rule, not just that one token.
    const a = getSkinPreset("atelier");
    const selection = (a.extras ?? "").match(/::selection\s*\{[^}]*\}/)?.[0] ?? "";
    const referenced = [...selection.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const token of referenced) {
      expect(a.light[token], `light is missing ${token}`).toBeTruthy();
      expect(a.dark[token], `dark is missing ${token}`).toBeTruthy();
    }
  });
  it("atelier drives its own face rather than falling through to Inter", () => {
    // Every other sector preset binds --font-sans to a dedicated face; atelier
    // was the one that did not, so it silently inherited the default.
    expect(getSkinPreset("atelier").extras).toContain("--font-sans: var(--font-atelier)");
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
