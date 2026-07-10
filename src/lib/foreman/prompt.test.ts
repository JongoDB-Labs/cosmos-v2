import { describe, it, expect } from "vitest";
import { foremanPrompt, repairPrompt } from "./prompt";

const brief = {
  key: "COSMOS-2",
  title: "Failing to create work role",
  description: "500 when saving a role with grants.",
  classification: "BUG" as const,
  acceptanceCriteria: ["Creating a role with permissions succeeds", "A regression test covers it"],
};

describe("foremanPrompt", () => {
  it("names the ticket and embeds the criteria", () => {
    const p = foremanPrompt(brief);
    expect(p).toContain("COSMOS-2");
    expect(p).toContain("Creating a role with permissions succeeds");
  });
  it("carries the non-negotiable clauses", () => {
    const p = foremanPrompt(brief);
    expect(p).toMatch(/AGENTS\.md/);
    expect(p).toMatch(/CLAUDE\.md/);
    expect(p).toMatch(/typecheck/);
    expect(p).toMatch(/npm version patch/); // BUG → patch
    expect(p).toMatch(/do not.*(merge|deploy|push)/i);
    expect(p).toMatch(/no.*attribution/i);
  });
  it("tells a FEATURE to bump minor", () => {
    expect(foremanPrompt({ ...brief, classification: "FEATURE" })).toMatch(/npm version minor/);
  });
});

describe("repairPrompt", () => {
  it("embeds the ticket key and the failing check output", () => {
    const p = repairPrompt("COSMOS-2", "FAIL src/x.test.ts — expected 1, received 2");
    expect(p).toContain("COSMOS-2");
    expect(p).toContain("expected 1, received 2");
  });
  it("forbids a second version bump and weakening tests", () => {
    const p = repairPrompt("COSMOS-2", "…");
    expect(p).toMatch(/do not bump the version again/i);
    expect(p).toMatch(/never weaken or delete an existing test/i);
    expect(p).toMatch(/do not start over/i);
  });
  it("keeps the original hard limits in force", () => {
    expect(repairPrompt("COSMOS-2", "…")).toMatch(/hard limits.*still apply/i);
  });
});
