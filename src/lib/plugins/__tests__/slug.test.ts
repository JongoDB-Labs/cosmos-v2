import { describe, it, expect } from "vitest";
import { pluginModelPrefix } from "../slug";

describe("pluginModelPrefix", () => {
  it("passes a single-word slug through unchanged", () => {
    expect(pluginModelPrefix("foreman")).toBe("foreman");
  });

  it("camelCases a hyphenated slug to match the Prisma client accessor", () => {
    // Prisma exposes `model PiPlanningCard` as `prisma.piPlanningCard`.
    expect(pluginModelPrefix("pi-planning")).toBe("piPlanning");
  });

  it("handles multiple hyphens", () => {
    expect(pluginModelPrefix("a-b-c")).toBe("aBC");
  });

  it("handles a digit after a hyphen (no uppercase form)", () => {
    expect(pluginModelPrefix("v2-sync")).toBe("v2Sync");
  });
});
