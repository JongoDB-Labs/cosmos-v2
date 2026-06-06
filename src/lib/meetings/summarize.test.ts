import { describe, it, expect } from "vitest";
import { parseSummaryJson } from "./summarize";

describe("parseSummaryJson", () => {
  it("parses a clean JSON object", () => {
    const out = parseSummaryJson('{"summary":"S","tickets":[{"title":"T","description":"D","type":"TASK"}]}');
    expect(out.summary).toBe("S");
    expect(out.tickets).toHaveLength(1);
  });
  it("extracts JSON embedded in prose / code fences", () => {
    const out = parseSummaryJson('Sure!\n```json\n{"summary":"S","tickets":[]}\n```\nDone');
    expect(out.summary).toBe("S");
    expect(out.tickets).toEqual([]);
  });
  it("throws on unparseable input", () => {
    expect(() => parseSummaryJson("no json here")).toThrow();
  });
});
