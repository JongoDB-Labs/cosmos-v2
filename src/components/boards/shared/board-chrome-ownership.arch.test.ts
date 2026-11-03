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
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

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
