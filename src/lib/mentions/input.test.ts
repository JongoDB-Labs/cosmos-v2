import { describe, expect, it } from "vitest";
import { detectMentionQuery, insertMentionToken } from "./input";
import { parseRefs } from "./refs";

describe("detectMentionQuery", () => {
  it("returns the active @-query at the caret", () => {
    expect(detectMentionQuery("@ali", 4)).toBe("ali");
    expect(detectMentionQuery("hey @bob", 8)).toBe("bob");
  });

  it("returns '' immediately after a lone @", () => {
    expect(detectMentionQuery("hey @", 5)).toBe("");
  });

  it("only considers text before the caret", () => {
    expect(detectMentionQuery("@bob rest", 4)).toBe("bob");
  });

  it("closes the query at whitespace", () => {
    expect(detectMentionQuery("@bob ", 5)).toBeNull();
  });

  it("does not trigger on an email address (@ not preceded by whitespace)", () => {
    expect(detectMentionQuery("email a@b.com", 13)).toBeNull();
  });

  it("returns null when there is no @-query", () => {
    expect(detectMentionQuery("hello world", 11)).toBeNull();
  });
});

describe("insertMentionToken", () => {
  it("replaces the active @-query with a legacy person token + trailing space", () => {
    const { value, caret } = insertMentionToken("hey @bo", 7, "user", "u1");
    expect(value).toBe("hey <@u1> ");
    expect(caret).toBe(value.length);
  });

  it("replaces with a typed <@type:id> token", () => {
    const { value } = insertMentionToken("see @wo", 7, "workItem", "wi1");
    expect(value).toBe("see <@workItem:wi1> ");
    // The inserted token is the canonical, parseable schema form.
    expect(parseRefs(value)).toEqual([{ type: "workItem", id: "wi1" }]);
  });

  it("works at the start of the input", () => {
    const { value, caret } = insertMentionToken("@al", 3, "user", "u2");
    expect(value).toBe("<@u2> ");
    expect(caret).toBe(6);
  });

  it("preserves text after the caret", () => {
    const { value, caret } = insertMentionToken("@al rest", 3, "user", "u2");
    expect(value).toBe("<@u2>  rest");
    expect(caret).toBe(6);
  });
});
