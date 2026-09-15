import { describe, it, expect } from "vitest";
import { stripMarkdown } from "./note-markdown";
import { userMentionLabels } from "@/lib/mentions/plain-text";

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

  it("names the person when a label map is supplied", () => {
    const id = "f1244511-9f53-4a78-b4d0-91851b50de2e";
    expect(
      stripMarkdown(`ping <@${id}> now`, userMentionLabels([{ id, displayName: "Bob" }])),
    ).toBe("ping @Bob now");
  });

  it("falls back to @someone with no label map, and never shows the raw id", () => {
    // Was the literal "@mention" for every person alike, which told a reader
    // that SOMEONE was mentioned and nothing more.
    const out = stripMarkdown("ping <@f1244511-9f53-4a78-b4d0-91851b50de2e> now");
    expect(out).toBe("ping @someone now");
    expect(out).not.toContain("f1244511");
  });

  it("also resolves TYPED tokens, which the old strip left as raw ids", () => {
    const out = stripMarkdown("see <@workItem:9f53-4a78> please");
    expect(out).toBe("see #work item please");
    expect(out).not.toContain("<@");
  });

  it("keeps link text, drops the url", () => {
    expect(stripMarkdown("see [the doc](https://example.com)")).toBe(
      "see the doc",
    );
  });
});
