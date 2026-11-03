// A stub of a filter surface must pass the board's actions through.
//
// `FilterBar` and `BoardQueryBar` now HOST a board's actions in an `actions`
// slot, so the chrome is one band rather than two with character-for-character
// identical classes (ffe324aa; see kanban-board.one-band.test.tsx).
//
// Fifteen test files stub those surfaces to `() => null` to keep their control
// trees out of an unrelated test. That was free when the toolbar was a SIBLING
// band. Now it swallows "New issue", "Group by", the density toggles and the
// scope notice -- and the test goes green while blind to the controls it exists
// to exercise. `table-view.grouping.test.tsx` hit exactly this and only said
// "the Group by select is gone", which cost real time to trace.
//
// The rule is scoped to boards that ACTUALLY pass `actions`, so it stays true
// as the remaining boards convert instead of demanding the change up front:
// convert a board, and this starts holding its tests to the passthrough.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { codeWithoutComments } from "../../../lib/arch/code-without-comments";

const BOARDS = "src/components/boards";
const SURFACE_MODULES = ["shared/filter-bar", "shared/board-query-bar"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

// Shared helper: six copies of this had diverged, and every one stripped
// block comments BEFORE line comments, so a line comment containing a
// block-opener sequence was read as a real block opener and blanked the
// file to the next close. In board-tabs.tsx that hid 371 lines, including
// the element one of these rules asserts on. See code-without-comments.
const code = codeWithoutComments;

const files = walk(BOARDS);
const views = files.filter((f) => !/\.(test|spec)\.tsx?$/.test(f));
const tests = files.filter((f) => /\.test\.tsx$/.test(f));

/** Board views that hand their actions to a filter surface. */
const converted = views.filter((f) => /actions=\{/.test(code(readFileSync(f, "utf8"))));

describe("filter-surface stubs pass actions through", () => {
  it("found the board views and their tests", () => {
    // Positive control: a glob that matched nothing would make the rule vacuous.
    expect(views.length).toBeGreaterThan(10);
    expect(tests.length).toBeGreaterThan(20);
  });

  it("found at least one converted board", () => {
    // The rule only bites on converted boards, so zero of them means this file
    // asserts nothing at all.
    expect(converted.length).toBeGreaterThan(0);
  });

  it("no test of a converted board stubs a filter surface without its actions", () => {
    const offenders: string[] = [];
    const convertedDirs = new Set(converted.map((f) => f.split("/").slice(0, -1).join("/")));

    for (const t of tests) {
      const dir = t.split("/").slice(0, -1).join("/");
      if (!convertedDirs.has(dir)) continue;
      const src = code(readFileSync(t, "utf8"));
      for (const mod of SURFACE_MODULES) {
        if (!src.includes(mod)) continue;
        // Does this file stub the surface at all?
        const stubs = /(FilterBar|BoardQueryBar)\s*:\s*\(/.test(src);
        if (!stubs) continue;
        if (!/\bactions\b/.test(src)) {
          offenders.push(`${t} stubs ${mod} but never mentions \`actions\``);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
