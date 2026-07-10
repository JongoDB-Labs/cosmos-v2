import { describe, it, expect } from "vitest";
import { reviewerPrompt, parseReviewVerdict } from "./review";
import type { TicketBrief } from "./prompt";

const brief: TicketBrief = {
  key: "COSMOS-9",
  title: "Sprint board shows wrong items",
  description: "Board leaks items from other sprints.",
  classification: "BUG",
  acceptanceCriteria: ["Only the viewed sprint's items appear"],
};

describe("reviewerPrompt", () => {
  it("inline diff: embeds the fenced diff text in the prompt (no file access needed)", () => {
    const p = reviewerPrompt(brief, { kind: "inline", text: "--- a/x.ts\n+++ b/x.ts\n+fixed()" });
    expect(p).toContain("+fixed()");
    expect(p).toContain("```diff");
    expect(p).toContain("APPROVE:");
    expect(p).not.toContain("Read the full diff at"); // no file instruction in inline mode
  });

  it("file diff (oversized fallback): is adversarial, names the diff path, and demands the exact verdict format", () => {
    const p = reviewerPrompt(brief, { kind: "file", path: "/repo/.git/worktrees/K/FOREMAN_REVIEW.diff" });
    expect(p).toContain("/repo/.git/worktrees/K/FOREMAN_REVIEW.diff");
    expect(p).toContain("APPROVE:");
    expect(p).toContain("REJECT:");
    expect(p).toMatch(/read-only/i);
    expect(p).toContain("COSMOS-9");
    expect(p).toContain("Only the viewed sprint's items appear");
    // multi-tenancy is a review dimension (the repo's #1 data-safety concern)
    expect(p).toMatch(/org scoping|tenan/i);
  });

  it("handles empty acceptance criteria", () => {
    const p = reviewerPrompt({ ...brief, acceptanceCriteria: [] }, { kind: "file", path: "/d.diff" });
    expect(p).toMatch(/judge against the title/i);
  });
});

describe("parseReviewVerdict", () => {
  it("parses APPROVE with reason", () => {
    const v = parseReviewVerdict("…analysis…\nAPPROVE: change is correct and tested");
    expect(v).toEqual({ approve: true, reason: "change is correct and tested" });
  });

  it("parses REJECT with reason", () => {
    const v = parseReviewVerdict("…\nREJECT: test asserts the mock, not the behavior");
    expect(v.approve).toBe(false);
    expect(v.reason).toContain("asserts the mock");
  });

  it("last verdict line wins (a final reversal overrides)", () => {
    const v = parseReviewVerdict("APPROVE: looked fine at first\n…deeper reading…\nREJECT: drops org scoping");
    expect(v.approve).toBe(false);
  });

  it("hedged mid-sentence mentions don't register (line-start anchored)", () => {
    const v = parseReviewVerdict("I considered whether to REJECT: but the change is sound.\nAPPROVE: sound");
    expect(v.approve).toBe(true);
    expect(v.reason).toBe("sound");
  });

  it("FAIL-CLOSED: no verdict line at all is a reject", () => {
    const v = parseReviewVerdict("The change looks broadly reasonable but I ran out of context.");
    expect(v.approve).toBe(false);
    expect(v.reason).toMatch(/no verdict/i);
  });

  it("empty log is a reject", () => {
    expect(parseReviewVerdict("").approve).toBe(false);
  });
});
