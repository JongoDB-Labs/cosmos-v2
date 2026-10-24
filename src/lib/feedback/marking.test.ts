import { describe, it, expect } from "vitest";
import { COMMENT_MARKINGS, markingForcesInternal } from "./marking";

describe("markingForcesInternal", () => {
  it("keeps CUI and above internal unless the org ceiling already covers it", () => {
    expect(markingForcesInternal("CUI", "UNCLASSIFIED")).toBe(true);
    expect(markingForcesInternal("CONFIDENTIAL", "CUI")).toBe(true);
    expect(markingForcesInternal("CUI", "CUI")).toBe(false);
    expect(markingForcesInternal("CUI", "CONFIDENTIAL")).toBe(false);
  });

  it("never forces an unclassified or public marking", () => {
    expect(markingForcesInternal("UNCLASSIFIED", "PUBLIC")).toBe(false);
    expect(markingForcesInternal("PUBLIC", "PUBLIC")).toBe(false);
  });

  it("treats legacy FOUO as CUI, on either side", () => {
    expect(markingForcesInternal("FOUO", "UNCLASSIFIED")).toBe(true);
    expect(markingForcesInternal("CUI", "FOUO")).toBe(false);
    expect(markingForcesInternal("FOUO", "CUI")).toBe(false);
  });

  it("doesn't offer the retired FOUO marking", () => {
    expect(COMMENT_MARKINGS.map((m) => m.value)).not.toContain("FOUO");
  });
});
