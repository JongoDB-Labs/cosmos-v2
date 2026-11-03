// A board does not hand-roll chrome that a shared component owns.
//
// The companion to `chrome-bands.arch.test.ts`, which stops a board wrapping
// the filter surface in a second band. This one stops the other half: eleven
// hand-written toolbars drifted to four band heights, two gaps, three
// background treatments and three "Hide done" checkboxes, two of which looked
// alike and one of which did not.
//
// These are facts about CALL SITES, which is why they cannot be component
// tests. `HideDoneToggle` reads no context, so a component test comparing two
// instances is identical by construction and can never fail -- the thing
// actually worth asserting is that no board builds its own.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { codeWithoutComments } from "../../../lib/arch/code-without-comments";

const BOARDS_DIR = "src/components/boards";
/** The shared components themselves are where this markup is allowed to live. */
const OWNERS = new Set([
  join(BOARDS_DIR, "shared", "board-toolbar.tsx"),
  join(BOARDS_DIR, "shared", "filter-bar.tsx"),
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Blank block comments rather than dropping them, so line numbers stay true. */
// Shared helper: six copies of this had diverged, and every one stripped
// block comments BEFORE line comments, so a line comment containing a
// block-opener sequence was read as a real block opener and blanked the
// file to the next close. In board-tabs.tsx that hid 371 lines, including
// the element one of these rules asserts on. See code-without-comments.
const code = codeWithoutComments;

const views = walk(BOARDS_DIR)
  .filter((f) => !OWNERS.has(f))
  .map((file) => ({ file, lines: code(readFileSync(file, "utf8")).split("\n") }));

describe("board chrome ownership", () => {
  it("found the board views to check", () => {
    // Positive control: an empty list would make every rule below vacuous.
    expect(views.length).toBeGreaterThanOrEqual(10);
  });

  it("no board builds its own Hide-done control", () => {
    const offenders: string[] = [];
    for (const { file, lines } of views) {
      lines.forEach((line, i) => {
        if (!/Hide done/i.test(line)) return;
        // A hand-rolled one is an <input type="checkbox"> within a few lines.
        const near = lines.slice(Math.max(0, i - 8), i + 2).join("\n");
        if (/type="checkbox"/.test(near)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("no board hides its Interval filter by passing an empty list", () => {
    // `FilterBar` guards the Interval control on `intervals.length > 0`, so
    // `intervals={[]}` silently removes it. Four boards did that -- Backlog,
    // Calendar, Roadmap, RAID -- while 2.509.0 wired the PI-rollup predicate
    // into their `matchesFilters` calls, so the rollup had no control to drive
    // it. Backlog and Roadmap were already loading `intervals` and just never
    // passed it; Calendar and RAID had to fetch it.
    //
    // `teams={[]}` is deliberately NOT asserted here: the team rule needs the
    // `teamsByUserId` map to work at all (board-filters.ts documents it as
    // "inert rather than silently hiding everything" without one), so exposing
    // that control is a data-wiring change per board, not a prop. It is a known
    // gap, tracked separately rather than hidden behind a passing test.
    const offenders: string[] = [];
    for (const { file, lines } of views) {
      lines.forEach((line, i) => {
        if (/intervals=\{\[\]\}/.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("no board offers the Team filter with an inert team map", () => {
    // The Team rule is "items naming the team, PLUS its members' items that
    // name no team", so it needs the userId -> teams map. `board-filters.ts`
    // documents the 4th argument as making the filter "inert rather than
    // silently hiding everything" when absent — which means a board passing
    // `new Map()` shows a Team control that does nothing. All six boards that
    // used to do exactly that now fetch teams and derive the map.
    //
    // This is the companion to the interval rule above: there the control was
    // missing, here it would have been present and dead. Both are the same
    // defect — a filter that looks like it worked.
    const offenders: string[] = [];
    for (const { file, lines } of views) {
      lines.forEach((line, i) => {
        if (/matchesFilters\(/.test(line) && /new Map\(\)/.test(line)) {
          offenders.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("no board hides its Team filter by passing an empty list", () => {
    const offenders: string[] = [];
    for (const { file, lines } of views) {
      lines.forEach((line, i) => {
        if (/teams=\{\[\]\}/.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("every board that shows a Hide-done control imports the shared one", () => {
    const offenders: string[] = [];
    for (const { file, lines } of views) {
      const src = lines.join("\n");
      if (!/Hide done/i.test(src)) continue;
      if (!/HideDoneToggle|HIDE_DONE_LABEL/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
