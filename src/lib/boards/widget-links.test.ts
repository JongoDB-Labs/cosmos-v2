// The one link rule a Link List is drawn with AND saved with. Every hostile
// target is run through BOTH paths: the renderer's filter (`widgetLinks`, with
// and without a viewer origin) and the save routes' check
// (`widgetLinkProblems`). A good in-app path and a good external link are the
// positive controls, so an empty result is the rule talking and not a parser
// that returns nothing.
import { describe, it, expect } from "vitest";
import {
  checkWidgetLinkTarget,
  drawnPathStaysOn,
  widgetLinkLines,
  widgetLinkProblems,
  widgetLinkRefusal,
} from "./widget-links";
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

/**
 * Dot segments the URL parser folds away. Each one passes a check on the TYPED
 * text (it starts with one "/", holds no backslash or space) but resolves to
 * `//evil.example…`, which a browser reads as another site. So the rule has to
 * judge the href it DRAWS, not the text it was given.
 */
const DOT_SEGMENTS: Array<[string, string]> = [
  ["/.//evil.example", "//evil.example"],
  ["/a/..//evil.example", "//evil.example"],
  ["/%2e//evil.example", "//evil.example"],
  ["/%2E//evil.example", "//evil.example"],
  ["/..//evil.example/x?q#h", "//evil.example/x?q#h"],
  ["/a/b/../..//evil.example", "//evil.example"],
  ["/a/%2e%2e//evil.example", "//evil.example"],
  ["/a/.%2E//evil.example", "//evil.example"],
  ["/././/evil.example", "//evil.example"],
];

describe("widget link validation", () => {
  it.each(DOT_SEGMENTS)(
    "refuses %s, which resolves to %s, on both paths",
    (target, resolved) => {
      // The premise: the parser really does fold this to a protocol-relative
      // path. If it ever stops, this test says so instead of passing vacuously.
      const folded = new URL(target, VIEWER);
      expect(`${folded.pathname}${folded.search}${folded.hash}`).toBe(resolved);
      expect(drawn(target)).toEqual([]);
      expect(refusedOnSave(target)).toEqual([
        `"Runbooks", line 1: the link leads out of the app once its "." and ".." parts are resolved.`,
      ]);
    },
  );

  it("says why a protocol-relative link is refused before resolving anything", () => {
    // Its own reason, from the check on the typed text — the drawn-href check
    // would refuse it too, in other words.
    expect(checkWidgetLinkTarget("//evil.example")).toEqual({
      ok: false,
      reason: "starts with // and would leave the app",
    });
  });

  it("keeps a dot segment that stays inside the app (positive control)", () => {
    expect(drawn("/acme/b/../projects/./ACME")).toEqual([
      { label: "L", href: "/acme/projects/ACME", external: false },
    ]);
    expect(drawn("/%2e%2e/acme")).toEqual([{ label: "L", href: "/acme", external: false }]);
    expect(refusedOnSave("/acme/b/../projects")).toEqual([]);
  });

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

  it("keeps the refusal short: the first problem and a count, never the whole list", () => {
    // The builder shows this in a toast; the list of every bad line grew over
    // the Save button on localhost. The routes send the full list as `issues`.
    const one = ['"L", line 1: the link starts with // and would leave the app.'];
    expect(widgetLinkRefusal(one)).toBe(`A link can't be saved. ${one[0]}`);
    expect(widgetLinkRefusal([...one, "b"])).toBe(`A link can't be saved. ${one[0]} 1 more link has a problem too.`);
    expect(widgetLinkRefusal([...one, "b", "c", "d"])).toBe(
      `A link can't be saved. ${one[0]} 3 more links have a problem too.`,
    );
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

// `drawnPathStaysOn` holds two tests: the href starts with ONE "/", and it
// resolves to the app's own origin. Through `checkWidgetLinkTarget` each
// already catches everything the other does, so neither can be shown to
// matter from there. These run the helper on what its caller screens out
// first, which is exactly where a second test has to hold on its own.
describe("drawnPathStaysOn: each half holds without the other", () => {
  const BASE = "https://app.invalid";

  it("refuses a path a tab or newline splits into //host, though it starts with one /", () => {
    // Premise: the URL parser drops the tab, so this resolves to another site.
    expect(new URL("/\t/evil.example", BASE).origin).toBe("https://evil.example");
    expect(drawnPathStaysOn("/\t/evil.example", BASE)).toBe(false);
    expect(drawnPathStaysOn("/\n/evil.example", BASE)).toBe(false);
  });

  it("refuses //host and /\\host even when the host is the app's own", () => {
    // Premise: both resolve to the app itself, so only the leading-slash test
    // can refuse them.
    expect(new URL("//app.invalid/x", BASE).origin).toBe(BASE);
    expect(new URL("/\\app.invalid/x", BASE).origin).toBe(BASE);
    expect(drawnPathStaysOn("//app.invalid/x", BASE)).toBe(false);
    expect(drawnPathStaysOn("/\\app.invalid/x", BASE)).toBe(false);
  });

  it("keeps a plain path (positive control)", () => {
    expect(drawnPathStaysOn("/acme/projects/ACME?x=1#top", BASE)).toBe(true);
  });
});
