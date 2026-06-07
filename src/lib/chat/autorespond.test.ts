import { describe, expect, it } from "vitest";
import { shouldAnswererAutoRespond, isSlashCommand, type AutoRespondInput } from "./autorespond";

const base: AutoRespondInput = {
  messageKind: "USER",
  isThreadReply: false,
  isSlashCommand: false,
  authorIsBot: false,
  posterHasChatUse: true,
  mentionBot: null,
  answererAutoRespondEnabled: true,
};

describe("shouldAnswererAutoRespond", () => {
  it("fires for a plain human question when the answerer is wired", () => {
    expect(shouldAnswererAutoRespond(base)).toBe(true);
  });

  it("does NOT fire when the answerer isn't wired for auto-respond", () => {
    expect(shouldAnswererAutoRespond({ ...base, answererAutoRespondEnabled: false })).toBe(false);
  });

  it("does NOT double-trigger when a mention already fired", () => {
    expect(shouldAnswererAutoRespond({ ...base, mentionBot: "assistant" })).toBe(false);
    // Even an @answerer mention must not ALSO auto-respond.
    expect(shouldAnswererAutoRespond({ ...base, mentionBot: "answerer" })).toBe(false);
  });

  it("does NOT loop on a bot/assistant/system message", () => {
    expect(shouldAnswererAutoRespond({ ...base, authorIsBot: true })).toBe(false);
    expect(shouldAnswererAutoRespond({ ...base, messageKind: "ASSISTANT" })).toBe(false);
    expect(shouldAnswererAutoRespond({ ...base, messageKind: "SYSTEM" })).toBe(false);
  });

  it("ignores ACTION messages (only a USER message triggers)", () => {
    expect(shouldAnswererAutoRespond({ ...base, messageKind: "ACTION" })).toBe(false);
  });

  it("does NOT fire on a thread reply", () => {
    expect(shouldAnswererAutoRespond({ ...base, isThreadReply: true })).toBe(false);
  });

  it("does NOT fire on a slash command", () => {
    expect(shouldAnswererAutoRespond({ ...base, isSlashCommand: true })).toBe(false);
  });

  it("does NOT fire when the poster lacks CHAT_USE", () => {
    expect(shouldAnswererAutoRespond({ ...base, posterHasChatUse: false })).toBe(false);
  });
});

describe("isSlashCommand", () => {
  it("detects a leading slash (with optional leading whitespace)", () => {
    expect(isSlashCommand("/ai what's up")).toBe(true);
    expect(isSlashCommand("   /notes")).toBe(true);
  });
  it("is false for ordinary text", () => {
    expect(isSlashCommand("how do I deploy?")).toBe(false);
    expect(isSlashCommand("path is a/b/c")).toBe(false);
    expect(isSlashCommand("")).toBe(false);
  });
});
