import { describe, it, expect } from "vitest";
import { planSplit } from "./split-assignees";

describe("planSplit", () => {
  it("keeps the first assignee and splits off everyone after them, in order", () => {
    expect(planSplit(["a", "b", "c"])).toEqual({ keep: "a", splitOff: ["b", "c"] });
  });

  it("has nothing to split with fewer than two distinct assignees", () => {
    expect(planSplit([])).toBeNull();
    expect(planSplit(["a"])).toBeNull();
    expect(planSplit(["a", "a"])).toBeNull();
  });
});
