import { describe, expect, it } from "vitest";
import { SECTOR_FIELD_TEMPLATES, SECTOR_FIELD_SECTORS } from "./sector-field-templates";

/** Catalog invariants (FR 454637a9) — the seeding logic depends on these. */
describe("SECTOR_FIELD_TEMPLATES", () => {
  it("covers the 7 template sectors + govcon", () => {
    expect(new Set(SECTOR_FIELD_SECTORS)).toEqual(
      new Set(["software", "govcon", "aec", "consulting", "education", "event", "manufacturing", "ops"]),
    );
  });

  it("every key is namespaced under its own sector (org-unique keyspace)", () => {
    for (const [sector, defs] of Object.entries(SECTOR_FIELD_TEMPLATES)) {
      for (const def of defs) {
        expect(def.key.startsWith(`${sector}.`), `${def.key} must start with ${sector}.`).toBe(true);
      }
    }
  });

  it("keys are globally unique across all sectors", () => {
    const all = Object.values(SECTOR_FIELD_TEMPLATES).flat().map((d) => d.key);
    expect(new Set(all).size).toBe(all.length);
  });

  it("SELECT fields have options or resolve from classifications", () => {
    for (const def of Object.values(SECTOR_FIELD_TEMPLATES).flat()) {
      if (def.fieldType === "SELECT" || def.fieldType === "MULTI_SELECT") {
        expect(
          Array.isArray(def.options) || def.optionsFromClassifications === true,
          `${def.key} needs options[] or optionsFromClassifications`,
        ).toBe(true);
      }
    }
  });

  it("only the classification field resolves from the classification vocabulary", () => {
    const dynamic = Object.values(SECTOR_FIELD_TEMPLATES).flat().filter((d) => d.optionsFromClassifications);
    expect(dynamic.map((d) => d.key)).toEqual(["govcon.security-classification"]);
  });
});
