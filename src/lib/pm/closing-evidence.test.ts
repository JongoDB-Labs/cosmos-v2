import { describe, it, expect } from "vitest";
import { closingDecision } from "./closing-evidence";

const base = { ruleOn: true, wasClosed: false, willBeClosed: true, edits: false, files: 0, note: null };

describe("closingDecision", () => {
  it("rule off: never refuses", () => {
    expect(closingDecision({ ...base, ruleOn: false })).toBeNull();
    expect(closingDecision({ ...base, ruleOn: false, wasClosed: true, edits: true })).toBeNull();
  });
  it("closing needs a file or a reason that says something", () => {
    expect(closingDecision(base)?.code).toBe("close_evidence_required");
    expect(closingDecision({ ...base, note: "  " })?.code).toBe("close_evidence_required");
    expect(closingDecision({ ...base, files: 1 })).toBeNull();
    expect(closingDecision({ ...base, note: "Verbal sign-off" })).toBeNull();
  });
  it("a closed record refuses edits while it stays closed", () => {
    expect(closingDecision({ ...base, wasClosed: true, edits: true })?.code).toBe("closed_read_only");
    expect(closingDecision({ ...base, wasClosed: true, edits: false })).toBeNull();
  });
  it("reopening is always allowed, edits and all", () => {
    expect(closingDecision({ ...base, wasClosed: true, willBeClosed: false, edits: true })).toBeNull();
  });
  it("an open record that stays open is untouched", () => {
    expect(closingDecision({ ...base, willBeClosed: false, edits: true })).toBeNull();
  });
});
