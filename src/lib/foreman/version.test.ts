import { describe, it, expect } from "vitest";
import { bumpForClassification } from "./version";

describe("bumpForClassification", () => {
  it("features are minor releases", () => {
    expect(bumpForClassification("FEATURE")).toBe("minor");
  });
  it("bugs are patch releases", () => {
    expect(bumpForClassification("BUG")).toBe("patch");
  });
});
