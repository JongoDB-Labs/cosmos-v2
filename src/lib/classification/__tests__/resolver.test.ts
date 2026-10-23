import { describe, it, expect } from "vitest";
import { classificationResolverFromRows } from "../resolver";

const P_CUI = "p-cui";
const P_LOW = "p-low";

describe("classificationResolverFromRows", () => {
  const r = classificationResolverFromRows([
    { projectId: null, level: "UNCLASSIFIED" },
    { projectId: P_CUI, level: "CUI" },
    { projectId: P_LOW, level: "PUBLIC" },
  ]);

  it("a project row raises the ceiling but never lowers it below the org row", () => {
    expect(r.levelFor(P_CUI)).toBe("CUI");
    expect(r.levelFor(P_LOW)).toBe("UNCLASSIFIED");
    expect(r.levelFor(null)).toBe("UNCLASSIFIED");
    expect(r.levelFor("unknown")).toBe("UNCLASSIFIED");
  });

  it("restricted: marking-level ceiling or marked text", () => {
    expect(r.restricted(P_CUI, "plain")).toBe(true);
    expect(r.restricted(P_LOW, "plain", null)).toBe(false);
    expect(r.restricted(P_LOW, "plain", "CUI//SP-PRVCY roster")).toBe(true);
  });

  it("rowLevel raises a marked row to CUI and never lowers a higher ceiling", () => {
    expect(r.rowLevel(P_LOW, "Contains CUI")).toBe("CUI");
    expect(r.rowLevel(P_LOW, "fine")).toBe("UNCLASSIFIED");
    const high = classificationResolverFromRows([{ projectId: null, level: "CONFIDENTIAL" }]);
    expect(high.rowLevel(null, "CUI")).toBe("CONFIDENTIAL");
  });

  it("no rows → UNCLASSIFIED (conservative, not public)", () => {
    expect(classificationResolverFromRows([]).orgLevel).toBe("UNCLASSIFIED");
  });
});
