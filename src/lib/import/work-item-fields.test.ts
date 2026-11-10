import { describe, expect, it } from "vitest";
import { guessTarget, TARGET_FIELDS } from "./work-item-fields";

/** Import mapping additions (user report 2026-07-06): sprint/interval, multi-
 *  assignee, completed date, generalized parent link. */
describe("work-item import targets", () => {
  it("offers the new targets", () => {
    const ids = TARGET_FIELDS.map((t) => t.id);
    for (const t of ["interval", "assignees", "completedAt"]) expect(ids).toContain(t);
  });

  it("auto-guesses sprint/interval/iteration headers", () => {
    expect(guessTarget("Sprint")).toBe("interval");
    expect(guessTarget("interval")).toBe("interval");
    expect(guessTarget("Iteration")).toBe("interval");
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

  // The mapper's own labels were renamed from "Issue Type / Issue Key / Issue
  // ID". A sheet whose headers were copied from those labels must still map
  // itself, and so must the "work item" spelling of the old Jira names.
  it("maps a header written as the mapper's own label", () => {
    for (const id of ["type", "externalKey", "externalId"] as const) {
      const label = TARGET_FIELDS.find((t) => t.id === id)!.label;
      expect(guessTarget(label), label).toBe(id);
    }
    expect(guessTarget("Work item key")).toBe("externalKey");
    expect(guessTarget("Work item ID")).toBe("externalId");
  });

  it("still maps the Jira 'issue' headers", () => {
    expect(guessTarget("Issue Type")).toBe("type");
    expect(guessTarget("Issue key")).toBe("externalKey");
    expect(guessTarget("Issue id")).toBe("externalId");
  });
});
