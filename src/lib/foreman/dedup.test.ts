import { describe, it, expect } from "vitest";
import { normalizeTitle, tokenOverlap, prefilter } from "./dedup";

describe("dedup prefilter", () => {
  it("normalizes: lowercases, strips [tags] and punctuation", () => {
    expect(normalizeTitle("[Bug] Failing to create Work Role!")).toBe("failing to create work role");
  });
  it("high overlap for near-identical titles", () => {
    expect(tokenOverlap("Failing to create work role", "Can't create a work role")).toBeGreaterThan(0.6);
  });
  it("low overlap for unrelated titles", () => {
    expect(tokenOverlap("Dark mode toggle", "Export issues to CSV")).toBeLessThan(0.3);
  });
  it("prefilter returns only candidates above threshold", () => {
    const cands = [
      { ref: "COSMOS-2", title: "Cannot create work role" },
      { ref: "COSMOS-9", title: "Add dark mode" },
    ];
    const out = prefilter("Failing to create work role", cands, 0.5);
    expect(out.map((c) => c.ref)).toEqual(["COSMOS-2"]);
  });
});
