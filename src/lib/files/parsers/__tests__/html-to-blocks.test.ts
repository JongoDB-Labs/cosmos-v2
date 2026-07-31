import { describe, it, expect } from "vitest";
import { htmlToBlocks } from "../html-to-blocks";

/**
 * Characterization tests for the ONLY consumer of `node-html-parser`.
 *
 * Ingest turns uploaded documents into blocks: mammoth converts a .docx to an
 * HTML fragment, and this maps that fragment onto `ParsedBlock[]`. Everything a
 * user sees from an uploaded document flows through here.
 *
 * It leans on a specific slice of the library's API — `parse()`, `childNodes`,
 * `tagName`, `text`, `innerHTML`, and `querySelectorAll` — and had no direct
 * coverage, so a major-version bump of the parser could silently change how
 * documents are ingested with nothing to object. These tests pin the observable
 * mapping so such a bump either passes or names what it broke.
 */
describe("htmlToBlocks", () => {
  it("maps h1..h6 to HEADING with the right level", () => {
    const blocks = htmlToBlocks("<h1>Title</h1><h3>Sub</h3>");
    expect(blocks).toEqual([
      { kind: "HEADING", level: 1, text: "Title" },
      { kind: "HEADING", level: 3, text: "Sub" },
    ]);
  });

  it("maps a paragraph to PARAGRAPH and trims its text", () => {
    expect(htmlToBlocks("<p>  hello  </p>")).toEqual([
      { kind: "PARAGRAPH", text: "hello" },
    ]);
  });

  it("drops empty paragraphs rather than emitting blank blocks", () => {
    // A blank block would render as an empty line in the document view.
    expect(htmlToBlocks("<p></p><p>   </p>")).toEqual([]);
  });

  it("keeps a list's inner markup on the block, not just its text", () => {
    const [block] = htmlToBlocks("<ul><li>one</li><li>two</li></ul>");
    expect(block.kind).toBe("LIST");
    // `text` concatenates the items; `html` must survive for richer rendering.
    expect(block.text).toContain("one");
    expect(block.text).toContain("two");
    expect(block.html).toBe("<li>one</li><li>two</li>");
  });

  it("extracts table cells into rows, honouring both th and td", () => {
    const [block] = htmlToBlocks(
      "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
    );
    expect(block.kind).toBe("TABLE");
    expect(block.data).toEqual({ rows: [["A", "B"], ["1", "2"]] });
    // The flattened text is what search and previews index.
    expect(block.text).toBe("A | B\n1 | 2");
  });

  it("maps blockquote to QUOTE", () => {
    expect(htmlToBlocks("<blockquote>quoted</blockquote>")).toEqual([
      { kind: "QUOTE", text: "quoted" },
    ]);
  });

  it("falls back to PARAGRAPH for an unrecognised tag that carries text", () => {
    expect(htmlToBlocks("<div>loose text</div>")).toEqual([
      { kind: "PARAGRAPH", text: "loose text" },
    ]);
  });

  it("preserves document order across mixed content", () => {
    const kinds = htmlToBlocks(
      "<h2>H</h2><p>p</p><ul><li>l</li></ul><blockquote>q</blockquote>",
    ).map((b) => b.kind);
    expect(kinds).toEqual(["HEADING", "PARAGRAPH", "LIST", "QUOTE"]);
  });

  it("returns no blocks for empty input", () => {
    expect(htmlToBlocks("")).toEqual([]);
  });
});
