import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the egress chokepoint so the title generator is exercised WITHOUT a real
// model call — asserting it routes through runModelTurn (the single egress path)
// with a cheap, tool-less, low-token request.
const runModelTurn = vi.fn();
vi.mock("./egress", () => ({
  runModelTurn: (...args: unknown[]) => runModelTurn(...args),
}));

import {
  cleanTitle,
  generateConversationTitle,
  DEFAULT_CONVERSATION_TITLE,
} from "./conversation-title";

describe("cleanTitle", () => {
  it("strips surrounding quotes and trailing punctuation", () => {
    expect(cleanTitle('"Fix the login bug."')).toBe("Fix the login bug");
  });

  it("removes a leading 'Title:' label", () => {
    expect(cleanTitle("Title: Q3 Roadmap Planning")).toBe("Q3 Roadmap Planning");
  });

  it("keeps only the first non-empty line", () => {
    expect(cleanTitle("\nDeploy Pipeline Fixes\nblah blah")).toBe(
      "Deploy Pipeline Fixes",
    );
  });

  it("collapses internal whitespace", () => {
    expect(cleanTitle("Weekly   status\treport")).toBe("Weekly status report");
  });

  it("caps the length at 60 characters", () => {
    const long = "A ".repeat(60) + "end";
    expect(cleanTitle(long).length).toBeLessThanOrEqual(60);
  });

  it("returns empty string for empty / whitespace input", () => {
    expect(cleanTitle("")).toBe("");
    expect(cleanTitle("   \n  ")).toBe("");
    expect(cleanTitle('""')).toBe("");
  });
});

describe("generateConversationTitle", () => {
  beforeEach(() => runModelTurn.mockReset());

  const base = {
    orgId: "org-1",
    userId: "user-1",
    conversationId: "conv-1",
    tenantClass: "commercial" as const,
    model: "sonnet",
    firstUserMessage: "help me plan the Q3 roadmap",
    firstAssistantMessage: "Sure, here is a plan...",
  };

  it("routes through runModelTurn with no tools and a low token budget, cleaning the result", async () => {
    runModelTurn.mockResolvedValue({ text: '"Q3 Roadmap Planning"', toolUses: [], stopReason: "end_turn" });
    const title = await generateConversationTitle(base);
    expect(title).toBe("Q3 Roadmap Planning");

    expect(runModelTurn).toHaveBeenCalledTimes(1);
    const arg = runModelTurn.mock.calls[0][0];
    expect(arg.tools).toEqual([]);
    expect(arg.maxTokens).toBeLessThanOrEqual(32);
    expect(arg.model).toBe("sonnet");
    // ctx threads the conversation identity so egress audits/correlates it.
    expect(arg.ctx).toMatchObject({ orgId: "org-1", conversationId: "conv-1", tenantClass: "commercial" });
  });

  it("returns '' when the model reply is malformed/absent (catch keeps the default)", async () => {
    // A null reply makes `reply.text` throw INSIDE the try — the same code path a
    // model/credential error takes — proving titling never breaks the flow.
    runModelTurn.mockResolvedValue(null);
    expect(await generateConversationTitle(base)).toBe("");
  });

  it("returns '' when the model yields nothing usable", async () => {
    runModelTurn.mockResolvedValue({ text: "   ", toolUses: [], stopReason: "end_turn" });
    expect(await generateConversationTitle(base)).toBe("");
  });

  it("exposes the default-title sentinel", () => {
    expect(DEFAULT_CONVERSATION_TITLE).toBe("New conversation");
  });
});
