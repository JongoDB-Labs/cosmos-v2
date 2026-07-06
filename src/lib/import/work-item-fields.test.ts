import { describe, expect, it } from "vitest";
import { guessTarget, TARGET_FIELDS } from "./work-item-fields";

/** Import mapping additions (user report 2026-07-06): sprint/cycle, multi-
 *  assignee, completed date, generalized parent link. */
describe("work-item import targets", () => {
  it("offers the new targets", () => {
    const ids = TARGET_FIELDS.map((t) => t.id);
    for (const t of ["cycle", "assignees", "completedAt"]) expect(ids).toContain(t);
  });

  it("auto-guesses sprint/cycle/iteration headers", () => {
    expect(guessTarget("Sprint")).toBe("cycle");
    expect(guessTarget("cycle")).toBe("cycle");
    expect(guessTarget("Iteration")).toBe("cycle");
  });

  it("auto-guesses resolved/completed headers", () => {
    expect(guessTarget("Resolved")).toBe("completedAt");
    expect(guessTarget("Completed Date")).toBe("completedAt");
  });

  it("auto-guesses the assignees (multiple) header", () => {
    expect(guessTarget("Assignees")).toBe("assignees");
    expect(guessTarget("Assignee")).toBe("assignee"); // singular stays single
  });

  it("parent link keeps its Jira synonyms", () => {
    expect(guessTarget("Epic Link")).toBe("parentKey");
    expect(guessTarget("Parent")).toBe("parentKey");
  });
});
