import { describe, it, expect } from "vitest";
import { resolveBrandIcon } from "./brand-icons";

describe("resolveBrandIcon", () => {
  it("resolves a brand recovered from legacy simple-icons (slack)", () => {
    // slack was removed from simple-icons v16 for trademark reasons;
    // it is recovered from legacy v13 via the fallback in generate-brand-icons.mjs
    const i = resolveBrandIcon("slack");
    expect(i).not.toBeNull();
    expect(i!.path.length).toBeGreaterThan(0);
  });
  it("returns null for an unknown icon (caller renders a monogram)", () => {
    expect(resolveBrandIcon("definitely-not-a-brand-xyz")).toBeNull();
  });
});
