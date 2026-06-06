// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseSearchQuery } from "./route";

describe("parseSearchQuery", () => {
  it("separates free text from operators", () => {
    expect(parseSearchQuery("deploy from:@alice in:#general")).toEqual({
      text: "deploy",
      filters: { from: "alice", in: "general" },
    });
  });

  it("strips a leading # or @ from operator values", () => {
    expect(parseSearchQuery("in:#eng from:@bob").filters).toEqual({ in: "eng", from: "bob" });
  });

  it("supports has / before / after", () => {
    const { text, filters } = parseSearchQuery("notes has:link before:2026-01-01 after:2025-12-01");
    expect(text).toBe("notes");
    expect(filters).toEqual({ has: "link", before: "2026-01-01", after: "2025-12-01" });
  });

  it("a bare operator with no value is treated as free text, not a filter", () => {
    expect(parseSearchQuery("from:")).toEqual({ text: "from:", filters: {} });
  });

  it("a plain query yields no filters", () => {
    expect(parseSearchQuery("hello world")).toEqual({ text: "hello world", filters: {} });
  });

  it("keeps multi-word free text alongside operators", () => {
    expect(parseSearchQuery("release plan in:general")).toEqual({
      text: "release plan",
      filters: { in: "general" },
    });
  });
});
