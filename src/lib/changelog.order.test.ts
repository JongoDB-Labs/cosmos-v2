/**
 * The product changelog's order is COMPUTED, so the file may be in any order.
 *
 * ## Why that freedom exists
 *
 * Every release adds an entry, and while the file required newest-first ordering
 * every release inserted at the SAME first line. Two branches each adding an
 * entry therefore always collided, and a branch that sat while several releases
 * landed collided with all of them.
 *
 * On 2026-09-15 seven core releases shipped in a day. `auto/COSMOS-158` was cut
 * at 2.371.1, could not rebase against any of them, and its change had to be
 * lifted onto a fresh branch by hand — while two other Foreman PRs sat in the
 * same state.
 *
 * With order computed, `.gitattributes` can mark the file `merge=union`: git
 * keeps both sides' added lines rather than reporting a conflict, and the sort
 * puts them right. These tests are what make that safe — if the sort is wrong,
 * union merge silently ships a changelog in arbitrary order.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHANGELOG, newestFirst, type Release } from "./changelog";

const cmp = (v: string) => v.split(".").map(Number);

describe("CHANGELOG is ordered newest-first regardless of file order", () => {
  it("has entries at all — anti-vacuity", () => {
    expect(CHANGELOG.length).toBeGreaterThan(100);
  });

  it("is sorted strictly newest-first", () => {
    for (let i = 1; i < CHANGELOG.length; i++) {
      const a = cmp(CHANGELOG[i - 1].version);
      const b = cmp(CHANGELOG[i].version);
      const newerOrEqual = a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])));
      expect(newerOrEqual, `${CHANGELOG[i - 1].version} should not precede ${CHANGELOG[i].version}`).toBe(true);
    }
  });

  it("CHANGELOG[0] is the MAXIMUM version, which is the contract consumers rely on", () => {
    // whats-new-modal takes CHANGELOG.slice(0, 12); updates/notes treats
    // CHANGELOG[0].version as the current release.
    const max = CHANGELOG.reduce((m, r) => {
      const a = cmp(r.version), b = cmp(m.version);
      const bigger = a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
      return bigger ? r : m;
    });
    expect(CHANGELOG[0].version).toBe(max.version);
  });

  it("sorts NUMERICALLY, not lexically", () => {
    // THE TRAP, tested on the COMPARATOR with crafted input rather than on the
    // real data. Today's versions are all 2.1xx-2.3xx, so lexical and numeric
    // order happen to agree at the top and the real list cannot distinguish
    // them — a test over it would pass against a string compare. It would start
    // failing silently the first time a 2.4xx release shipped.
    const r = (version: string): Release => ({ version, date: "2026-01-01", title: "t", highlights: [{ kind: "fix", text: "x" }] });
    // "2.99.0" > "2.372.0" as strings; 2.372.0 is the newer release.
    expect([r("2.372.0"), r("2.99.0")].sort(newestFirst)[0].version).toBe("2.372.0");
    expect([r("2.99.0"), r("2.372.0")].sort(newestFirst)[0].version).toBe("2.372.0");
    // Same trap one component along, and on the patch.
    expect([r("2.9.0"), r("2.10.0")].sort(newestFirst)[0].version).toBe("2.10.0");
    expect([r("1.0.9"), r("1.0.10")].sort(newestFirst)[0].version).toBe("1.0.10");
    // And a major that a string compare would also get wrong.
    expect([r("9.0.0"), r("10.0.0")].sort(newestFirst)[0].version).toBe("10.0.0");
  });

  it("every entry is well-formed", () => {
    for (const r of CHANGELOG as Release[]) {
      expect(r.version, `bad version: ${r.version}`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(r.date, `bad date on ${r.version}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.title.length, `empty title on ${r.version}`).toBeGreaterThan(0);
      expect(r.highlights.length, `no highlights on ${r.version}`).toBeGreaterThan(0);
    }
  });
});

describe("the ordering is APPLIED, not merely available", () => {
  // Every behavioural test above is satisfied by a file that happens to already
  // be in order — which it is today, so deleting the `.sort()` passes all of
  // them. Caught by mutation-testing this very file. Union merge is what makes
  // the file order arbitrary, and by then no runtime test could tell the
  // difference, so the assertion has to be on the source.
  const src = readFileSync(join(__dirname, "changelog.ts"), "utf8");

  it("exports CHANGELOG as a SORTED view of the raw entries", () => {
    expect(src).toMatch(/export const CHANGELOG: Release\[\] = \[\.\.\.RELEASES\]\.sort\(newestFirst\);/);
  });

  it("keeps the raw literal private, so nothing can read the file order by accident", () => {
    // If RELEASES were exported, a consumer could depend on file order and the
    // union merge would start reordering the app's UI.
    expect(src).toMatch(/^const RELEASES: Release\[\] = \[/m);
    expect(src).not.toMatch(/^export const RELEASES/m);
  });

  it("sorts a COPY — sorting RELEASES in place would make order load-dependent", () => {
    expect(src).toContain("[...RELEASES].sort(");
    expect(src).not.toMatch(/\bRELEASES\.sort\(/);
  });
});

describe("the union-merge attribute is actually declared", () => {
  it(".gitattributes marks the changelog merge=union", () => {
    // Without this line the sort above buys nothing: every release still
    // collides on the same first line. The two halves only work together.
    const ga = readFileSync(join(__dirname, "..", "..", ".gitattributes"), "utf8");
    expect(ga).toMatch(/^src\/lib\/changelog\.ts merge=union$/m);
  });
});
