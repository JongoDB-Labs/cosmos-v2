// Reading an org's sidebar layout out of an untyped JSON column.
//
// The column is written by several features and is not validated on the way in,
// so this has to survive whatever is actually in there. The failure that matters
// is not a wrong menu -- it is a throw, because an admin who cannot navigate
// cannot reach the screen that would fix the setting.
import { describe, expect, it } from "vitest";
import { readNavLayout, UNHIDEABLE_NAV_IDS } from "../nav-layout";

describe("reads what is there", () => {
  it("returns the hidden list", () => {
    expect(readNavLayout({ navLayout: { hidden: ["crm", "accounting"] } })).toEqual({
      hidden: ["crm", "accounting"],
    });
  });

  it("returns an explicit order", () => {
    expect(readNavLayout({ navLayout: { order: ["projects", "overview"] } })).toEqual({
      order: ["projects", "overview"],
    });
  });

  it("returns undefined when nothing is configured, so the caller keeps its default", () => {
    expect(readNavLayout({})).toBeUndefined();
    expect(readNavLayout({ navLayout: {} })).toBeUndefined();
    expect(readNavLayout({ navLayout: { hidden: [] } })).toBeUndefined();
  });
});

describe("never hides the way back", () => {
  it.each(UNHIDEABLE_NAV_IDS)("drops %s from the hidden list", (id) => {
    // Enforced on READ as well as on write: a value written before this rule
    // existed, or edited straight into the database, still cannot strand anyone.
    expect(readNavLayout({ navLayout: { hidden: [id, "crm"] } })).toEqual({ hidden: ["crm"] });
  });

  it("returns undefined when the only hidden ids were unhideable", () => {
    expect(readNavLayout({ navLayout: { hidden: ["settings"] } })).toBeUndefined();
  });
});

describe("survives a malformed column", () => {
  it.each([
    ["null settings", null],
    ["a string", "nav"],
    ["a number", 7],
    ["navLayout as a string", { navLayout: "crm" }],
    ["navLayout null", { navLayout: null }],
    ["hidden as a string", { navLayout: { hidden: "crm" } }],
    ["hidden holding non-strings", { navLayout: { hidden: ["crm", 3] } }],
    ["order as an object", { navLayout: { order: { a: 1 } } }],
  ])("returns undefined rather than throwing for %s", (_label, input) => {
    expect(() => readNavLayout(input)).not.toThrow();
    expect(readNavLayout(input)).toBeUndefined();
  });

  it("keeps a valid half when the other half is malformed", () => {
    expect(readNavLayout({ navLayout: { hidden: ["crm"], order: "nope" } })).toEqual({
      hidden: ["crm"],
    });
  });
});
