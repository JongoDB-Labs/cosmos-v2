// COSMOS-208: the ticket write-up template is stored as ONE markdown string;
// these lock the round trip between its three sections and that string.
import { describe, it, expect } from "vitest";
import { composeDescription, parseDescription, EMPTY_SECTIONS } from "./description-template";

describe("composeDescription", () => {
  it("writes each filled section under its heading, in order", () => {
    expect(
      composeDescription({
        description: "Collapse past PIs.",
        acceptanceCriteria: "- Past PIs start collapsed",
        definitionOfDone: "- Reviewed and merged",
      }),
    ).toBe(
      "## Description\n\nCollapse past PIs.\n\n## Acceptance criteria\n\n- Past PIs start collapsed\n\n## Definition of done\n\n- Reviewed and merged",
    );
  });

  it("leaves out empty sections", () => {
    expect(composeDescription({ ...EMPTY_SECTIONS, description: "Why", definitionOfDone: "- Shipped" })).toBe(
      "## Description\n\nWhy\n\n## Definition of done\n\n- Shipped",
    );
  });

  it("keeps a description-only write-up as plain prose, and all-empty as empty", () => {
    expect(composeDescription({ ...EMPTY_SECTIONS, description: "  Just prose.  " })).toBe("Just prose.");
    expect(composeDescription(EMPTY_SECTIONS)).toBe("");
  });
});

describe("parseDescription", () => {
  it("reads a composed write-up back into its sections", () => {
    const s = { description: "Why", acceptanceCriteria: "- A\n- B", definitionOfDone: "- Done" };
    expect(parseDescription(composeDescription(s))).toEqual(s);
  });

  it("puts plain prose, and unknown headings, in Description so nothing is lost", () => {
    expect(parseDescription("Just prose.")).toEqual({ ...EMPTY_SECTIONS, description: "Just prose." });
    const parsed = parseDescription("Intro\n\n### Notes\nmore\n\n## Acceptance criteria\n- A");
    expect(parsed.description).toBe("Intro\n\n### Notes\nmore");
    expect(parsed.acceptanceCriteria).toBe("- A");
  });

  it("matches the headings case-insensitively at any level", () => {
    expect(parseDescription("# definition of DONE\n- Shipped").definitionOfDone).toBe("- Shipped");
  });
});
