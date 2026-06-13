import { describe, it, expect } from "vitest";
import { anchorAssigner } from "../slug";
describe("anchorAssigner", () => {
  it("slugs text and de-dups within a document", () => {
    const next = anchorAssigner();
    expect(next("2. Deliverables", 1)).toBe("2-deliverables");
    expect(next("2. Deliverables", 2)).toBe("2-deliverables-2");
    expect(next("", 3)).toBe("block-3");
  });
});
