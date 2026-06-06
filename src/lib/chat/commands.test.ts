import { describe, expect, it } from "vitest";
import { COMMANDS, parseSlash, matchCommands } from "./commands";

describe("parseSlash", () => {
  it("returns null when text doesn't start with a slash", () => {
    expect(parseSlash("hello /me")).toBeNull();
  });
  it("parses a known command + args", () => {
    expect(parseSlash("/topic launch week")).toEqual({ command: "topic", args: "launch week", known: true });
  });
  it("parses a command with no args", () => {
    expect(parseSlash("/leave")).toEqual({ command: "leave", args: "", known: true });
  });
  it("marks unknown commands as not known (passthrough)", () => {
    expect(parseSlash("/wat now")).toEqual({ command: "wat", args: "now", known: false });
  });
  it("is case-insensitive on the command token", () => {
    expect(parseSlash("/ME waves")?.command).toBe("me");
  });
  it("treats '/ text' (slash + space) as not a command", () => {
    expect(parseSlash("/ text")).toBeNull();
  });
});

describe("matchCommands (typeahead)", () => {
  it("filters by prefix (non-admin commands)", () => {
    const names = matchCommands("m", false).map((c) => c.name);
    expect(names).toContain("me");
    expect(names).toContain("mute");
    expect(names).not.toContain("topic");
  });
  it("hides admin-only commands for non-managers even when the prefix matches", () => {
    expect(matchCommands("t", false).map((c) => c.name)).not.toContain("topic");
    expect(matchCommands("i", false).map((c) => c.name)).not.toContain("invite");
  });
  it("shows admin-only commands for managers when the prefix matches", () => {
    expect(matchCommands("t", true).map((c) => c.name)).toContain("topic");
  });
  it("hides admin-only commands for non-managers", () => {
    const names = matchCommands("", false).map((c) => c.name);
    expect(names).not.toContain("topic");
    expect(names).not.toContain("invite");
  });
  it("shows admin-only commands for managers", () => {
    const names = matchCommands("", true).map((c) => c.name);
    expect(names).toContain("topic");
    expect(names).toContain("invite");
  });
});

describe("COMMANDS catalog", () => {
  it("has the expected v1 set", () => {
    expect(COMMANDS.map((c) => c.name).sort()).toEqual(
      ["ai", "dm", "help", "invite", "leave", "me", "mute", "notes", "shrug", "topic"].sort(),
    );
  });
});
