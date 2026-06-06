import { describe, expect, it } from "vitest";
import { detectBotMention } from "./bot-runner";

describe("detectBotMention", () => {
  it("fires on a deliberate @mention at the start", () => {
    expect(detectBotMention("@ai what's our status?")).toBe("assistant");
    expect(detectBotMention("@assistant help")).toBe("assistant");
    expect(detectBotMention("@notetaker")).toBe("notetaker");
  });

  it("fires mid-sentence when preceded by whitespace", () => {
    expect(detectBotMention("hey @ai please summarize")).toBe("assistant");
    expect(detectBotMention("ok @notetaker, capture this")).toBe("notetaker");
  });

  it("is case-insensitive", () => {
    expect(detectBotMention("@AI go")).toBe("assistant");
    expect(detectBotMention("@NoteTaker go")).toBe("notetaker");
  });

  it("allows trailing punctuation that is not a domain/handle char", () => {
    expect(detectBotMention("@ai!")).toBe("assistant");
    expect(detectBotMention("@ai?")).toBe("assistant");
    expect(detectBotMention("@ai, thoughts?")).toBe("assistant");
  });

  it("does NOT fire on email/domain tokens (the @ai.com false-positive)", () => {
    expect(detectBotMention("ping @ai.com about the invoice")).toBeNull();
    expect(detectBotMention("CC x @ai.company for this")).toBeNull();
    expect(detectBotMention("see @assistant-bot.example")).toBeNull();
    expect(detectBotMention("mail x@ai.com")).toBeNull(); // no space before @ → no match
  });

  it("does NOT fire when the keyword runs into another word", () => {
    expect(detectBotMention("@ainsley said hi")).toBeNull();
    expect(detectBotMention("@assistants meeting")).toBeNull();
    expect(detectBotMention("@notetakers list")).toBeNull();
  });

  it("returns null when there is no mention", () => {
    expect(detectBotMention("")).toBeNull();
    expect(detectBotMention("just a normal message")).toBeNull();
    expect(detectBotMention("email me at bob@example.com")).toBeNull();
  });

  it("note-taker takes precedence when both are present", () => {
    expect(detectBotMention("@notetaker and @ai")).toBe("notetaker");
  });
});
