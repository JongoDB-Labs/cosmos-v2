import { describe, it, expect } from "vitest";
import { camelSlug } from "./slug.mjs";
import { pluginModelPrefix } from "@/lib/plugins/slug";

const CASES = ["foreman", "pi-planning", "a-b-c", "v2-sync", "x", "already-camel-ish"];

describe("camelSlug", () => {
  it("passes a single-word slug through unchanged", () => {
    expect(camelSlug("foreman")).toBe("foreman");
  });

  it("produces a valid JS identifier from a hyphenated slug", () => {
    // The generated registry imports `<camelSlug>Manifest`; `pi-planningManifest`
    // would be a syntax error.
    expect(camelSlug("pi-planning")).toBe("piPlanning");
    expect(`${camelSlug("pi-planning")}Manifest`).toMatch(/^[A-Za-z_$][\w$]*$/);
  });

  it("handles multiple hyphens", () => {
    expect(camelSlug("a-b-c")).toBe("aBC");
  });

  it("handles a digit after a hyphen", () => {
    expect(camelSlug("v2-sync")).toBe("v2Sync");
  });

  // Guards the duplicated implementation: sync.mjs cannot import the TS twin,
  // and the arch tests cannot import this .mjs, so they must be checked against
  // each other or they will drift.
  it("agrees with the TypeScript twin for every case", () => {
    for (const s of CASES) {
      expect(camelSlug(s), `mismatch for "${s}"`).toBe(pluginModelPrefix(s));
    }
  });
});
