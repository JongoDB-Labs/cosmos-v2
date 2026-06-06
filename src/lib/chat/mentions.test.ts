import { describe, expect, it } from "vitest";
import { parseMentions, MENTION_RE } from "./mentions";

describe("parseMentions", () => {
  it("returns deduped user ids from <@uuid> tokens", () => {
    const got = parseMentions(
      "hey <@11111111-1111-1111-1111-111111111111> and <@22222222-2222-2222-2222-222222222222> and again <@11111111-1111-1111-1111-111111111111>",
    );
    expect(got.sort()).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    ]);
  });

  it("ignores bare @text and non-uuid tokens", () => {
    expect(parseMentions("@bob hello <@not-a-uuid> world")).toEqual([]);
  });

  it("returns [] on empty input", () => {
    expect(parseMentions("")).toEqual([]);
  });

  it("normalizes hex to lowercase", () => {
    expect(parseMentions("<@AAAAAAAA-aaaa-AAAA-aaaa-aaaaaaaaaaaa>")).toEqual([
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    ]);
  });

  it("matches multiple uuids in a single sentence", () => {
    const got = parseMentions(
      "<@11111111-1111-1111-1111-111111111111><@22222222-2222-2222-2222-222222222222>",
    );
    expect(got.sort()).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    ]);
  });

  it("the regex is case-insensitive on hex", () => {
    expect(MENTION_RE.test("<@AAAAAAAA-aaaa-AAAA-aaaa-aaaaaaaaaaaa>")).toBe(true);
  });

  it("ignores legacy @bob alongside modern tokens", () => {
    const got = parseMentions(
      "@bob hi <@11111111-1111-1111-1111-111111111111> @also-ignored",
    );
    expect(got).toEqual(["11111111-1111-1111-1111-111111111111"]);
  });
});
