import { describe, expect, it } from "vitest";
import { topics, parseTopic } from "./topics";

describe("topics", () => {
  it("builds org topic", () => {
    expect(topics.org("abc")).toBe("org:abc");
  });

  it("builds user topic", () => {
    expect(topics.user("u1")).toBe("user:u1");
  });

  it("builds channel topic", () => {
    expect(topics.channel("c1")).toBe("channel:c1");
  });

  it("parses org topic", () => {
    expect(parseTopic("org:abc")).toEqual({ kind: "org", id: "abc" });
  });

  it("parses user topic", () => {
    expect(parseTopic("user:u1")).toEqual({ kind: "user", id: "u1" });
  });

  it("parses channel topic", () => {
    expect(parseTopic("channel:c1")).toEqual({ kind: "channel", id: "c1" });
  });

  it("returns null for unknown topic kind", () => {
    expect(parseTopic("foo:bar")).toBeNull();
  });

  it("returns null for missing colon", () => {
    expect(parseTopic("not-a-topic")).toBeNull();
  });

  it("returns null for empty id", () => {
    expect(parseTopic("user:")).toBeNull();
  });

  it("preserves ids containing colons after the kind separator", () => {
    expect(parseTopic("channel:c1:extra")).toEqual({ kind: "channel", id: "c1:extra" });
  });
});
