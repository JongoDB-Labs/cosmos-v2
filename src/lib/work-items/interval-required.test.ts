// COSMOS-205: which work-item types must join an interval at create.
import { describe, it, expect } from "vitest";
import { requiresInterval } from "./interval-required";

describe("requiresInterval", () => {
  it("covers built-in Stories and Features in any sector, and bare custom keys", () => {
    for (const k of ["software.story", "consulting.story", "story", "feature", "software.feature", "Software.Story"]) {
      expect(requiresInterval(k), k).toBe(true);
    }
  });

  it("leaves every other type alone, including look-alike keys", () => {
    for (const k of ["software.task", "software.bug", "software.epic", "storyboard", "user-story-map", "", null, undefined]) {
      expect(requiresInterval(k as string), String(k)).toBe(false);
    }
  });
});
