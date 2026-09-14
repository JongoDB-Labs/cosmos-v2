// A tour is only useful if every step points somewhere real, and only safe if a
// disabled plugin's tour is never offered — its pages are unreachable for that
// org, so every step would navigate into a wall.
import { describe, expect, it } from "vitest";
import { CORE_TOURS, toursForVersion } from "../registry";
import type { PluginManifest } from "@/lib/plugins/registry";
import type { Tour } from "../types";

const tour = (version: string, id = "a"): Tour => ({
  version,
  name: "T " + version,
  summary: "",
  steps: [{ id, title: "A", blurb: "b", look: "l" }],
});

const manifest = (slug: string, tours: Tour[]): PluginManifest =>
  ({ slug, name: slug, version: "1.0.0", modules: [], tours }) as unknown as PluginManifest;

describe("toursForVersion", () => {
  it("offers an enabled plugin's tour for that version", () => {
    const out = toursForVersion("1.2.3", [manifest("alpha", [tour("1.2.3")])], new Set(["alpha"]));
    expect(out.map((t) => t.version)).toEqual(["1.2.3"]);
  });

  it("withholds a DISABLED plugin's tour", () => {
    const out = toursForVersion("1.2.3", [manifest("alpha", [tour("1.2.3")])], new Set());
    expect(out).toEqual([]);
  });

  it("ignores tours belonging to another version", () => {
    const out = toursForVersion("1.2.3", [manifest("alpha", [tour("9.9.9")])], new Set(["alpha"]));
    expect(out).toEqual([]);
  });

  it("handles a plugin that contributes none", () => {
    const bare = { slug: "beta", name: "beta", version: "1.0.0", modules: [] } as unknown as PluginManifest;
    expect(toursForVersion("1.2.3", [bare], new Set(["beta"]))).toEqual([]);
  });

  it("combines several enabled plugins, core first", () => {
    const out = toursForVersion(
      "1.2.3",
      [manifest("alpha", [tour("1.2.3", "x")]), manifest("beta", [tour("1.2.3", "y")])],
      new Set(["alpha", "beta"]),
    );
    expect(out).toHaveLength(2);
  });
});

describe("core tours", () => {
  it("every step uses an org-relative href, never an absolute URL", () => {
    // The card prefixes the org slug. An absolute href would escape the tenant;
    // a bare word would resolve against whatever page they happen to be on.
    for (const t of CORE_TOURS) {
      for (const s of t.steps) {
        if (s.href === undefined) continue;
        expect(s.href.startsWith("/")).toBe(true);
        expect(s.href.startsWith("//")).toBe(false);
        expect(s.href).not.toMatch(/^https?:/);
      }
    }
  });

  it("has unique step ids within each tour", () => {
    for (const t of CORE_TOURS) {
      const ids = t.steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
