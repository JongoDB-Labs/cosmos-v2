import { describe, it, expect } from "vitest";
import { ROADMAP_NODE_KINDS, roadmapImportNodeSchema } from "./types";

describe("roadmap node kinds", () => {
  it("no longer accepts MILESTONE", () => {
    // A project has ONE kind of milestone: the Milestone table, shown on the
    // Milestones board, the Release Timeline and the Gantt. A roadmap node
    // could never have been one — it carries no date and Milestone.dueDate is
    // required — so a MILESTONE node was a document heading wearing the word,
    // and it made "milestone" mean different things on different boards.
    expect(ROADMAP_NODE_KINDS).not.toContain("MILESTONE");

    const rejected = roadmapImportNodeSchema.safeParse({
      kind: "MILESTONE",
      title: "ATO granted",
    });
    expect(
      rejected.success,
      "an import must not be able to reintroduce a second milestone type",
    ).toBe(false);
  });

  it("still accepts the kinds a roadmap document is actually made of", () => {
    for (const kind of ROADMAP_NODE_KINDS) {
      const parsed = roadmapImportNodeSchema.safeParse({ kind, title: `a ${kind}` });
      expect(parsed.success, `${kind} should import`).toBe(true);
    }
  });
});
