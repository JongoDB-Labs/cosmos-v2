// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseGroomingReply } from "./supervisor";

describe("parseGroomingReply", () => {
  it("extracts a delivered judgment from a JSON reply with stray prose", () => {
    const raw =
      'Here is my analysis:\n{"delivered":true,"deliveredConfidence":0.9,' +
      '"evidence":"main sprint-board.tsx scopes to active sprint","dupOf":null,"dupConfidence":0}';
    const j = parseGroomingReply(raw);
    expect(j.delivered).toBe(true);
    expect(j.deliveredConfidence).toBeCloseTo(0.9);
    expect(j.evidence).toContain("sprint-board");
    expect(j.dupOf).toBeNull();
  });

  it("defaults to a safe non-delivered judgment when JSON is absent/garbage", () => {
    const j = parseGroomingReply("model refused");
    expect(j.delivered).toBe(false);
    expect(j.deliveredConfidence).toBe(0);
    expect(j.dupOf).toBeNull();
    expect(j.evidence).toBe("");
  });

  it("clamps confidence to [0,1] and trims a duplicate key", () => {
    const j = parseGroomingReply('{"delivered":false,"deliveredConfidence":5,"dupOf":"  COSMOS-105  ","dupConfidence":0.8}');
    expect(j.deliveredConfidence).toBe(1);
    expect(j.dupOf).toBe("COSMOS-105");
    expect(j.dupConfidence).toBeCloseTo(0.8);
  });
});
