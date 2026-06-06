import { describe, it, expect } from "vitest";
import { stripMarkdown } from "./note-markdown";

/**
 * The notes-list card preview runs `stripMarkdown` over content that is now
 * produced by the Lexical editor (which emits `~~strike~~`, combined emphasis,
 * etc.). Lock the behaviour so a future editor/markdown change can't silently
 * leave raw markers in the previews.
 */
describe("stripMarkdown", () => {
  it("strips bold and italic", () => {
    expect(stripMarkdown("**bold** and *italic*")).toBe("bold and italic");
  });

  it("strips combined bold+italic without leaking asterisks", () => {
    expect(stripMarkdown("***both***")).toBe("both");
  });

  it("strips ~~strikethrough~~ (the editor's double-tilde form)", () => {
    expect(stripMarkdown("~~struck~~ text")).toBe("struck text");
  });

  it("strips headings, lists, quotes and inline code", () => {
    expect(stripMarkdown("# Heading")).toBe("Heading");
    expect(stripMarkdown("- one\n- two")).toBe("one two");
    expect(stripMarkdown("1. first")).toBe("first");
    expect(stripMarkdown("> quoted")).toBe("quoted");
    expect(stripMarkdown("`code`")).toBe("code");
  });

  it("renders a <@uuid> mention token as @mention", () => {
    expect(
      stripMarkdown("ping <@f1244511-9f53-4a78-b4d0-91851b50de2e> now"),
    ).toBe("ping @mention now");
  });

  it("keeps link text, drops the url", () => {
    expect(stripMarkdown("see [the doc](https://example.com)")).toBe(
      "see the doc",
    );
  });
});
