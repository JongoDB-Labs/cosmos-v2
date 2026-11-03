// The filter surface owns its own band. A board must not wrap it in a second one.
//
// Both filter surfaces already carry `border-b px-4 py-2`: `FilterBar`'s root
// (filter-bar.tsx) and, as of this change, `BoardQueryBar`'s. Six boards wrapped
// the pair in ANOTHER bordered, padded div -- Table, Backlog, Calendar, Roadmap,
// RAID and Dashboard -- so those boards rendered two stacked bottom borders,
// double vertical padding, and ~px-8 of effective horizontal inset. Kanban and
// Timeline did not wrap, which is why the filter bar's left edge lined up with
// the toolbar beneath it on two boards and sat 16px in on six.
//
// That is most of what "clunky and spread out and taking up board real estate"
// was: not one fat control, but the same control banded twice on most boards.
//
// There is a second failure the wrapper caused, invisible from the markup:
// `BoardQueryBar` returns null when it has no schema yet (`q.schema` is
// fetched, with retry: false). A wrapper around a null child still paints its
// own padding and border, so a board whose /cql/schema request was merely slow
// -- or had failed -- showed an empty bordered strip where the filter bar
// belongs. Letting each surface own its band means "nothing to show" renders
// nothing at all.
//
// The rule is therefore about ownership, not about padding values: whoever
// renders the band sets its inset, and exactly one component does.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BOARDS_DIR = "src/components/boards";
/** How far above a filter surface a wrapper's opening tag can plausibly sit. */
const LOOKBACK = 8;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name))
      out.push(full);
  }
  return out;
}

/**
 * Strip comments, so prose mentioning a class name is not read as markup.
 *
 * Block comments are blanked rather than removed, so every reported line
 * number still points at the real line in the real file. A gate that names the
 * wrong line sends the next reader to the wrong place.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

const SURFACE = /<(FilterBar|BoardQueryBar)\b/;
/** An opening div that paints a bottom border. */
const BANDED_DIV = /<div[^>]*className=(?:"[^"]*|\{?`[^`]*)\bborder-b\b/;

/** Every file that renders a filter surface, found by what it renders. */
const renderers = walk(BOARDS_DIR)
  .map((file) => ({
    file,
    lines: code(readFileSync(file, "utf8")).split("\n"),
  }))
  .filter(({ lines }) => lines.some((l) => SURFACE.test(l)));

describe("board chrome bands", () => {
  it("finds the boards that render a filter surface", () => {
    // Positive control: if the discovery above silently matched nothing, every
    // assertion below would pass over an empty list.
    expect(renderers.length).toBeGreaterThanOrEqual(8);
  });

  it("never wraps a filter surface in a bordered band", () => {
    const offenders: string[] = [];
    for (const { file, lines } of renderers) {
      lines.forEach((line, i) => {
        if (!SURFACE.test(line)) return;
        for (let back = 1; back <= LOOKBACK && i - back >= 0; back++) {
          const above = lines[i - back];
          if (BANDED_DIV.test(above)) {
            offenders.push(
              `${file}:${i - back + 1} bands ${line.trim().slice(0, 40)} (line ${i + 1})`,
            );
            return;
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
