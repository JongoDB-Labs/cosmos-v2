// @vitest-environment jsdom
//
// BR: "links that are commented on tickets show the whole url after submitting
// the comment."
//
// Two distinct defects produced that one symptom, and both are asserted here:
//
//  1. There was no `[label](url)` branch in the tokenizer at all. The Lexical
//     comment editor exports anything it auto-linked as `[url](url)`, so a
//     PASTED link arrived in exactly the shape this renderer could not read —
//     the brackets rendered as literal text and the url appeared TWICE.
//  2. A bare url was rendered as its own link text in full. Measured at 437px
//     wide in a real comment thread.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MarkdownContent, splitTrailingPunctuation } from "./markdown-content";

afterEach(cleanup);

const NO_REFS = new Map();

function renderMd(content: string) {
  return render(<MarkdownContent content={content} refMap={NO_REFS} />);
}

const LONG =
  "https://example.com/very/long/path/to/a/specification/document?version=42&reviewer=bob";

describe("a bare url", () => {
  it("links the FULL url but shows a short label", () => {
    renderMd(`Spec: ${LONG}`);
    const a = screen.getByRole("link");
    expect(a).toHaveAttribute("href", LONG);
    // The reported symptom, stated as an assertion.
    expect(a.textContent).not.toBe(LONG);
    expect(a.textContent!.length).toBeLessThan(LONG.length);
    expect(a.textContent).toContain("example.com");
  });

  it("keeps the whole url reachable in the title", () => {
    renderMd(LONG);
    expect(screen.getByRole("link")).toHaveAttribute("title", LONG);
  });

  it("opens in a new tab without leaking the referrer", () => {
    renderMd(LONG);
    const a = screen.getByRole("link");
    expect(a).toHaveAttribute("target", "_blank");
    expect(a.getAttribute("rel")).toContain("noreferrer");
    expect(a.getAttribute("rel")).toContain("noopener");
  });

  it("does not swallow the sentence's punctuation into the href", () => {
    renderMd("See https://example.com/a.");
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://example.com/a");
    // The full stop must survive as text, not vanish into the link.
    expect(document.body.textContent).toContain(".");
  });

  it("keeps parentheses that belong to the url", () => {
    const wiki = "https://en.wikipedia.org/wiki/Foo_(bar)";
    renderMd(`see ${wiki}`);
    expect(screen.getByRole("link")).toHaveAttribute("href", wiki);
  });
});

describe("a markdown link", () => {
  it("renders a human label instead of the url", () => {
    renderMd("The [specification document](https://example.com/a/b/c) is ready");
    const a = screen.getByRole("link", { name: "specification document" });
    expect(a).toHaveAttribute("href", "https://example.com/a/b/c");
    // The brackets and the url must not appear as literal text.
    expect(document.body.textContent).not.toContain("](");
    expect(document.body.textContent).not.toContain("https://example.com/a/b/c");
  });

  it("shortens a label the EDITOR generated from the url itself", () => {
    // This is the `[url](url)` autolink round-trip — the actual reported case.
    renderMd(`[${LONG}](${LONG})`);
    const a = screen.getByRole("link");
    expect(a).toHaveAttribute("href", LONG);
    expect(a.textContent).not.toBe(LONG);
    expect(a.textContent!.length).toBeLessThan(LONG.length);
  });

  it("renders exactly one link for [url](url), not two", () => {
    // Before the `[label](url)` branch existed, the url inside the parentheses
    // autolinked on its own — so the bracketed copy showed as text beside it.
    renderMd(`[${LONG}](${LONG})`);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("falls back to a short url when the label is empty", () => {
    renderMd("[](https://example.com/a)");
    expect(screen.getByRole("link").textContent).toBe("example.com/a");
  });
});

describe("the other inline tokens still work", () => {
  it("keeps bold, italic, strike and code alongside a link", () => {
    renderMd("**b** *i* ~s~ `c` and https://example.com/x");
    expect(screen.getByText("b").tagName).toBe("STRONG");
    expect(screen.getByText("i").tagName).toBe("EM");
    expect(screen.getByText("s").tagName).toBe("S");
    expect(screen.getByText("c").tagName).toBe("CODE");
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://example.com/x");
  });

  it("does not turn a bracketed non-link into a link", () => {
    renderMd("[not a link] and [also](not-a-url) here");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(document.body.textContent).toContain("[not a link]");
  });
});

describe("splitTrailingPunctuation", () => {
  it("strips sentence punctuation", () => {
    expect(splitTrailingPunctuation("https://x.com/a.")).toEqual(["https://x.com/a", "."]);
    expect(splitTrailingPunctuation("https://x.com/a,")).toEqual(["https://x.com/a", ","]);
    expect(splitTrailingPunctuation("https://x.com/a?!")).toEqual(["https://x.com/a", "?!"]);
  });

  it("strips an unbalanced closing paren but keeps a balanced one", () => {
    expect(splitTrailingPunctuation("https://x.com/a)")).toEqual(["https://x.com/a", ")"]);
    expect(splitTrailingPunctuation("https://x.com/a_(b)")).toEqual(["https://x.com/a_(b)", ""]);
  });

  it("leaves a clean url untouched", () => {
    expect(splitTrailingPunctuation("https://x.com/a")).toEqual(["https://x.com/a", ""]);
  });
});
