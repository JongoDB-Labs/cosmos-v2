import { describe, it, expect } from "vitest";
import { subjectKey, sameSubject } from "./subject";

describe("subjectKey", () => {
  it("separates fields so adjacent values cannot run together", () => {
    // Without a separator, {projectId:"ab"} and {projectId:"a", userId:"b"}
    // would produce the same key and one rule would silently clear the other.
    expect(subjectKey("r", { projectId: "ab" })).not.toBe(
      subjectKey("r", { projectId: "a", userId: "b" }),
    );
  });

  it("treats absent and null and empty as the same absence", () => {
    // The database index does this with COALESCE; if the code disagreed, a rule
    // would compute one identity and the constraint would enforce another.
    const a = subjectKey("r", { projectId: "p" });
    const b = subjectKey("r", { projectId: "p", userId: null });
    const c = subjectKey("r", { projectId: "p", userId: "" });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("distinguishes rules with identical subjects", () => {
    const s = { projectId: "p" };
    expect(subjectKey("burn.over-fee", s)).not.toBe(subjectKey("burn.trending", s));
  });

  it("distinguishes plugin subjects of different types", () => {
    expect(subjectKey("r", { subjectType: "phase", subjectId: "1" })).not.toBe(
      subjectKey("r", { subjectType: "milestone", subjectId: "1" }),
    );
  });
});

describe("sameSubject", () => {
  it("ignores the rule and compares only what the flag is about", () => {
    expect(sameSubject({ projectId: "p" }, { projectId: "p", userId: null })).toBe(true);
    expect(sameSubject({ projectId: "p" }, { projectId: "q" })).toBe(false);
  });
});
