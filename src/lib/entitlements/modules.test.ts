import { describe, expect, it } from "vitest";
import {
  ALL_MODULE_KEYS,
  FIXED_MODULES,
  MODULES,
  SECTORS,
} from "./modules";

describe("module registry", () => {
  it("exposes the six gateable top-level modules (matching nav ids)", () => {
    expect(ALL_MODULE_KEYS).toEqual([
      "projects",
      "issues",
      "time-tracking",
      "crm",
      "accounting",
      "analytics",
    ]);
  });

  it("treats overview + settings as always-on (fixed, never gateable)", () => {
    expect(FIXED_MODULES).toEqual(["overview", "settings"]);
    for (const fixed of FIXED_MODULES) {
      expect(ALL_MODULE_KEYS).not.toContain(fixed);
    }
  });

  it("gives every module a human label", () => {
    for (const m of MODULES) {
      expect(m.label.length).toBeGreaterThan(0);
    }
  });

  it("includes the AEC sector among the seeded sectors", () => {
    expect(SECTORS).toContain("aec");
  });
});
