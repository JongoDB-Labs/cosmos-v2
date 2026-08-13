import { describe, it, expect } from "vitest";
import { piLabel } from "./schedule-tracker";

describe("piLabel", () => {
  it("shows the name the team gave the Program Increment", () => {
    expect(piLabel({ id: "i1", number: 7, name: "PI-001" })).toBe("PI-001");
  });

  it("never prefixes the interval number onto the name", () => {
    // `number` is a per-project sequence across EVERY interval, sprints
    // included, so a project's first PI is routinely #7. Rendering "PI-7 · PI-001"
    // invented an ordinal that does not exist and contradicted the name.
    const label = piLabel({ id: "i1", number: 7, name: "PI-001" });
    expect(label).not.toContain("PI-7");
    expect(label).not.toContain("7");
  });

  it("falls back to the sequence number only when there is no name", () => {
    expect(piLabel({ id: "i1", number: 7, name: "" })).toBe("Program Increment #7");
    expect(piLabel({ id: "i1", number: 3, name: "   " })).toBe("Program Increment #3");
  });
});
