// @vitest-environment node
//
// A layout is chrome. The page owns the heading.
//
// The project layout rendered `<h1>{project.name}</h1>` in its header bar, and
// that bar sits above EVERY page in the project. So every project page shipped
// two h1s — one from the layout, one from the page's own PageShell title — and
// on `projects/[key]` the two said the same words, about 110px apart, which
// reads as a render bug rather than a design. Members and Import had the same
// doubling with different text: semantically wrong, just less visible.
//
// This is the kind of thing nothing catches. Both headings render, both are
// styled, tsc has no opinion, and a screenshot looks plausible unless you
// notice the name twice. It shows up in a screen reader's heading list as two
// document titles per page, every page.
//
// The rule is structural rather than cosmetic: a layout persists across
// navigations, so whatever it renders cannot be THIS page's heading. Chrome
// gets a <p> and its own styling; the page keeps the h1.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

/**
 * The internal design-system area is a developer tool, not a product surface:
 * its layout IS the page for the gallery routes beneath it, and no client ever
 * sees it. Exempt deliberately rather than changed, so the rule stays about
 * the app.
 */
const EXEMPT = new Set(["src/app/internal/layout.tsx"]);

function layouts(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) layouts(full, out);
    else if (entry === "layout.tsx") out.push(full);
  }
  return out;
}

const found = layouts(join(ROOT, "src/app")).map((f) => relative(ROOT, f));

describe("layouts", () => {
  it("are actually being found", () => {
    // Guard the guard: if the walk breaks, the rule below checks nothing and
    // looks permanently green.
    expect(found.length).toBeGreaterThan(3);
    expect(found).toContain("src/app/(dashboard)/[orgSlug]/projects/[projectKey]/layout.tsx");
  });

  it("never declare the page heading", () => {
    const offenders = found.filter((rel) => {
      if (EXEMPT.has(rel)) return false;
      // Strip comments first — the explanation above each of these fixes names
      // the tag it exists to forbid.
      const code = readFileSync(join(ROOT, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      return /<h1[\s>]/.test(code);
    });
    expect(offenders).toEqual([]);
  });
});
