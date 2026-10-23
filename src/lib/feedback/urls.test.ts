import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { feedbackItemUrl } from "./urls";

describe("feedbackItemUrl", () => {
  it("opens the board on the item", () => {
    expect(feedbackItemUrl("acme", "f1")).toBe("/acme/feedback?item=f1");
  });
});

describe("feedback notifications", () => {
  // Every one of them used to send the reader to the bare board, to hunt for
  // their own item among the rest.
  it("link to the item, never to the bare board", () => {
    const src = readFileSync(join(__dirname, "remediate.ts"), "utf8");
    expect(src).not.toMatch(/url:\s*`\/\$\{[^}]+\}\/feedback`/);
    expect(src.match(/url: feedbackItemUrl\(/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });
});
