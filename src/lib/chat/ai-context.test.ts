import { describe, expect, it } from "vitest";
import { formatAiContext } from "./ai-context";

describe("formatAiContext", () => {
  it("formats messages oldest-first as 'Name: text'", () => {
    const out = formatAiContext(
      [
        { authorId: "1", content: "hello", createdAt: new Date("2026-01-01T00:00:00Z") },
        { authorId: "2", content: "hi there", createdAt: new Date("2026-01-01T00:01:00Z") },
      ],
      new Map([["1", "Alice"], ["2", "Bob"]]),
    );
    expect(out).toBe("Alice: hello\nBob: hi there");
  });

  it("resolves <@uuid> mentions to real display names", () => {
    const out = formatAiContext(
      [{ authorId: "1", content: "ping <@22222222-2222-2222-2222-222222222222>", createdAt: new Date() }],
      new Map([["1", "Alice"], ["22222222-2222-2222-2222-222222222222", "Bob"]]),
    );
    expect(out).toBe("Alice: ping @Bob");
  });

  it("falls back to '@someone' for unresolved mentions (never leaks the uuid)", () => {
    const out = formatAiContext(
      [{ authorId: "1", content: "ping <@33333333-3333-3333-3333-333333333333>", createdAt: new Date() }],
      new Map([["1", "Alice"]]),
    );
    expect(out).toBe("Alice: ping @someone");
  });

  it("prepends a channel name + topic preamble when provided", () => {
    const out = formatAiContext(
      [{ authorId: "1", content: "hi", createdAt: new Date() }],
      new Map([["1", "Alice"]]),
      { channelName: "general", channelTopic: "Team chat" },
    );
    expect(out).toBe("Channel: #general\nTopic: Team chat\n\nAlice: hi");
  });

  it("falls back to 'User' for unknown authors", () => {
    expect(formatAiContext([{ authorId: "x", content: "yo", createdAt: new Date() }], new Map())).toBe("User: yo");
  });

  it("returns empty string for no messages", () => {
    expect(formatAiContext([], new Map())).toBe("");
  });
});
