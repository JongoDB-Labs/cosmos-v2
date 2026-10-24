// fetch_url's HTML → text: what reaches the model is text, with nothing
// tag-shaped left in it however the page encodes or nests it.
import { describe, it, expect } from "vitest";
import { stripHtmlToText } from "./utility";

const TAG = /<[^<>]*>/;

describe("stripHtmlToText", () => {
  it("keeps the words, drops scripts, styles and comments, and decodes entities", () => {
    expect(stripHtmlToText("<p>Hello <b>world</b></p><script>steal()</script><style>p{}</style><!-- x -->&amp; caf&#233; &#x2603;"))
      .toBe("Hello world & café ☃");
  });

  it("decodes once, so an escaped entity stays text", () => {
    expect(stripHtmlToText("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
  });

  it("leaves no tag that entities were hiding", () => {
    const out = stripHtmlToText("<p>&lt;img src=x onerror=alert(1)&gt;hi</p>");
    expect(out).toBe("hi");
    expect(out).not.toMatch(TAG);
  });

  it("leaves no tag that stripping would join back together", () => {
    for (const input of ["<scr<script>ipt>alert(1)</scr</script>ipt>", "&lt;scr&lt;script&gt;ipt&gt;alert(1)", "<<b>img src=x onerror=y>>"]) {
      const out = stripHtmlToText(input);
      expect(out, input).not.toMatch(TAG);
      expect(out, input).not.toMatch(/<\s*(script|img)/i);
    }
  });

  it("doesn't throw on an out-of-range numeric entity", () => {
    expect(stripHtmlToText("a &#9999999; b")).toBe("a &#9999999; b");
  });
});

describe("stripHtmlToText end tags with attributes or whitespace", () => {
  it("drops a script block whose end tag carries junk", () => {
    expect(stripHtmlToText("a<script>evil()</script\t\n bar>b")).toBe("a b");
  });
  it("drops a style block whose end tag carries junk", () => {
    expect(stripHtmlToText("a<style>x{}</style foo>b")).toBe("a b");
  });
});
