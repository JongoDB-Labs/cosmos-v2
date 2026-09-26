// Core's import entities plus whatever ENABLED plugins add. Two things this
// must never get wrong: offering an entity whose writer is not registered
// (the reader does all the mapping work, then the last step fails), and
// letting a plugin quietly redefine one of core's own.
import { describe, expect, it } from "vitest";
import { ENTITY_DEFS, availableEntityDefs, type EntityDef } from "./entity-fields";

const def = (key: string): EntityDef => ({
  key, label: key, icon: "Box", blurb: "", fields: [], naturalKey: [],
});
const plugin = (slug: string, entities?: EntityDef[]) => ({ slug, importEntities: entities });

describe("what the wizard is allowed to offer", () => {
  it("offers core's entities when no plugin contributes", () => {
    const out = availableEntityDefs([plugin("alpha"), plugin("beta")], new Set(["alpha", "beta"]));
    expect(out.map((e) => e.key)).toEqual(ENTITY_DEFS.map((e) => e.key));
  });

  it("adds an enabled plugin's entities", () => {
    const out = availableEntityDefs([plugin("alpha", [def("timesheetRow")])], new Set(["alpha"]));
    expect(out.some((e) => e.key === "timesheetRow")).toBe(true);
  });

  it("withholds a DISABLED plugin's entities", () => {
    // Its writer is not registered, so offering it would fail at the last step.
    const out = availableEntityDefs([plugin("alpha", [def("timesheetRow")])], new Set());
    expect(out.some((e) => e.key === "timesheetRow")).toBe(false);
  });

  it("stamps the contributing plugin, so the writer can be found", () => {
    const out = availableEntityDefs([plugin("beta", [def("timesheetRow")])], new Set(["beta"]));
    expect(out.find((e) => e.key === "timesheetRow")?.pluginSlug).toBe("beta");
  });

  it("leaves core's own entities unstamped", () => {
    const out = availableEntityDefs([], new Set());
    expect(out.every((e) => e.pluginSlug === undefined)).toBe(true);
  });

  it("refuses to let a plugin redefine one of core's entities", () => {
    const hijack = { ...def("milestone"), label: "Hijacked" };
    const out = availableEntityDefs([plugin("alpha", [hijack])], new Set(["alpha"]));
    const milestones = out.filter((e) => e.key === "milestone");
    expect(milestones).toHaveLength(1);
    expect(milestones[0].label).not.toBe("Hijacked");
  });

  it("does not mutate the core registry", () => {
    const before = ENTITY_DEFS.length;
    availableEntityDefs([plugin("alpha", [def("x")])], new Set(["alpha"]));
    expect(ENTITY_DEFS).toHaveLength(before);
  });
});
