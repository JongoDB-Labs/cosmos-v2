// The one link rule a Link List is drawn with AND saved with. Every hostile
// target is run through BOTH paths: the renderer's filter (`widgetLinks`, with
// and without a viewer origin) and the save routes' check
// (`widgetLinkProblems`). A good in-app path and a good external link are the
// positive controls, so an empty result is the rule talking and not a parser
// that returns nothing.
import { describe, it, expect } from "vitest";
import { checkWidgetLinkTarget, widgetLinkLines, widgetLinkProblems } from "./widget-links";
import { widgetLinks } from "./widget-data";

const VIEWER = "https://cosmos.example.com";

/** What the page would draw for this one target, with and without an origin. */
function drawn(target: string) {
  const withOrigin = widgetLinks({ links: `L|${target}` }, VIEWER);
  const without = widgetLinks({ links: `L|${target}` });
  // Same verdict and same href either way: the server render (no window) and
  // the browser must agree, or hydration would flip the list.
  expect(withOrigin).toEqual(without);
  return withOrigin;
}

/** What the save routes would say about a layout holding this one target. */
function refusedOnSave(target: string) {
  return widgetLinkProblems([
    { id: "w", type: "link-list", config: { title: "Runbooks", links: `L|${target}` } },
  ]);
}

const HOSTILE: Array<[string, string]> = [
  ["a backslash path, which a browser reads as //evil.example", "/\\evil.example"],
  ["a tab inside the path", "/\t/evil.example"],
  ["a carriage return inside the path", "/\r/evil.example"],
  ["a non-breaking space inside the path", "/ /evil.example"],
  ["a protocol-relative URL", "//evil.example"],
  ["a script URL", "javascript:alert(1)"],
  ["a mixed-case script URL", "JavaScript:alert(1)"],
  ["a data URL", "data:text/html,<script>alert(1)</script>"],
  ["a user name and password before the host", "https://user:pw@evil.example"],
  ["a bare word", "runbook"],
];

describe("widget link validation", () => {
  it.each(HOSTILE)("refuses %s on both paths", (_why, target) => {
    expect(drawn(target)).toEqual([]);
    const problems = refusedOnSave(target);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^"Runbooks", line 1: the link /);
  });

  it("keeps an in-app path, drawn as its normalised path, on both paths (positive control)", () => {
    expect(drawn("/acme/projects/ACME/boards/standup?view=mine#top")).toEqual([
      { label: "L", href: "/acme/projects/ACME/boards/standup?view=mine#top", external: false },
    ]);
    // Dot segments are resolved, not drawn as typed.
    expect(drawn("/acme/./projects/../projects")).toEqual([
      { label: "L", href: "/acme/projects", external: false },
    ]);
    expect(refusedOnSave("/acme/projects/ACME")).toEqual([]);
  });

  it("treats an encoded backslash as part of an in-app path, which it is", () => {
    // `%5C` is not decoded by navigation, so it cannot turn into `//`. It is a
    // strange path on this site, not a way off it.
    const [link] = drawn("/%5Cevil.example");
    expect(link).toEqual({ label: "L", href: "/%5Cevil.example", external: false });
    expect(new URL(link.href, VIEWER).origin).toBe(VIEWER);
  });

  it("allows an https link to another site as EXTERNAL (it opens in a new tab)", () => {
    expect(drawn("https://evil.example")).toEqual([
      { label: "L", href: "https://evil.example/", external: true },
    ]);
    expect(refusedOnSave("https://evil.example")).toEqual([]);
  });

  it("names the widget, the line and the reason for each refused line, and only those", () => {
    const problems = widgetLinkProblems([
      {
        id: "a",
        type: "link-list",
        config: { links: "Docs|https://example.com/docs\n\nBad|/\\evil.example\nApp|/acme" },
      },
      { id: "b", type: "counter", config: { metric: "overdue" } },
      { id: "c", type: "link-list", config: { title: "More", links: "X|javascript:alert(1)" } },
    ]);
    expect(problems).toEqual([
      '"Link List", line 3: the link contains a backslash, a space or a control character.',
      '"More", line 1: the link is not an http or https link.',
    ]);
  });

  it("refuses links that are not text, and ignores what is not a widget", () => {
    expect(widgetLinkProblems([{ config: { links: ["https://example.com"] } }])).toHaveLength(1);
    expect(widgetLinkProblems(undefined)).toEqual([]);
    expect(widgetLinkProblems([null, 3, "x", { config: null }])).toEqual([]);
  });

  it("numbers lines as the author sees them, blank lines included", () => {
    expect(widgetLinkLines("\nA|/a\n\n https://example.com \n")).toEqual([
      { line: 2, label: "A", target: "/a" },
      { line: 4, label: "https://example.com", target: "https://example.com" },
    ]);
  });

  it("falls back to its own origin when given an unusable one", () => {
    expect(checkWidgetLinkTarget("/a", "not a url")).toEqual({ ok: true, href: "/a", external: false });
    expect(checkWidgetLinkTarget("/a", "data:,x")).toEqual({ ok: true, href: "/a", external: false });
  });
});
