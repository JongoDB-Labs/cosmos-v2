import { describe, it, expect } from "vitest";
import { foremanPrompt, repairPrompt, resumePrompt, resumeContextPrompt, continuePrompt } from "./prompt";

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

describe("resumePrompt", () => {
  it("names the ticket key and lists each instruction", () => {
    const p = resumePrompt("COSMOS-7", ["Use the shared helper", "Cover the empty case"]);
    expect(p).toContain("COSMOS-7");
    expect(p).toContain("Use the shared helper");
    expect(p).toContain("Cover the empty case");
  });
  it("tells the agent to work in the current worktree and re-run tests", () => {
    const p = resumePrompt("COSMOS-7", ["tweak it"]);
    expect(p).toMatch(/current worktree/i);
    expect(p).toMatch(/re-run relevant tests/i);
    expect(p).toMatch(/version\/changelog only if/i);
  });
});

describe("continuePrompt (COSMOS-131 turn-budget overflow)", () => {
  it("names the ticket and tells the agent to continue, not restart", () => {
    const p = continuePrompt("COSMOS-131");
    expect(p).toContain("COSMOS-131");
    expect(p).toMatch(/ran out of your turn budget/i);
    expect(p).toMatch(/partial work is intact/i);
    expect(p).toMatch(/do NOT start over/i);
  });
  it("keeps the build's hard limits in force (no push/deploy/tag, no attribution)", () => {
    const p = continuePrompt("COSMOS-131");
    expect(p).toMatch(/current worktree|CURRENT branch/i);
    expect(p).toMatch(/typecheck/);
    expect(p).toMatch(/do not.*(merge|deploy|push)/i);
    expect(p).toMatch(/no.*attribution/i);
  });
});

describe("resumeContextPrompt", () => {
  const brief = { key: "COSMOS-9", title: "Widget totals wrong", description: "Off-by-one in the roll-up." };

  it("embeds the ticket brief, the instructions, and the PR diff", () => {
    const p = resumeContextPrompt(brief, "diff --git a/x b/x\n+fixed", ["make it right"]);
    expect(p).toContain("COSMOS-9");
    expect(p).toContain("Widget totals wrong");
    expect(p).toContain("make it right");
    expect(p).toContain("Current PR diff:");
    expect(p).toContain("+fixed");
  });
  it("does NOT add a truncation note for a small diff", () => {
    const p = resumeContextPrompt(brief, "short diff", ["go"]);
    expect(p).not.toMatch(/diff truncated/i);
  });
  it("truncates and notes when the diff exceeds 150k chars", () => {
    const big = "x".repeat(150_001);
    const p = resumeContextPrompt(brief, big, ["go"]);
    expect(p).toMatch(/diff truncated/i);
    // The embedded diff is capped — the full 150k+1 body is not carried verbatim.
    expect(p.includes(big)).toBe(false);
  });
});
