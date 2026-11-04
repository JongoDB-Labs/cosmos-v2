// The project chrome above a board is ONE band.
//
// Measured on a live board: the project header (`px-4 py-3 border-b`, 53px) and
// the board-tab strip (its own `px-4 border-b`, 37px) were two stacked bands --
// 90px before the board's own chrome began, on a screen where the whole chrome
// already took 338 of 906 pixels. ffe324aa: "pushes the kanban board itself
// down way too much to where you have no visibility."
//
// They are now one row: identity left, tabs scrolling in the middle, project
// actions right. The tabs keep their own `overflow-x-auto`, and `min-w-0
// flex-1` is what confines the scroll to that strip so a project with many
// boards cannot push "Intervals" and the settings gear off the right edge.
//
// This is a structural fact about two files, which is why it is not a component
// test: the layout is an async server component, and the thing worth asserting
// is that the tab strip does not OWN a band while the layout draws one around
// it. `kanban-board.one-band.test.tsx` covers the board's own half by render.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { codeWithoutComments } from "../../../../../lib/arch/code-without-comments";

const DIR = "src/app/(dashboard)/[orgSlug]/projects/[projectKey]";
const LAYOUT = `${DIR}/layout.tsx`;
const TABS = `${DIR}/board-tabs.tsx`;

// Shared helper: six copies of this had diverged, and every one stripped
// block comments BEFORE line comments, so a line comment containing a
// block-opener sequence was read as a real block opener and blanked the
// file to the next close. In board-tabs.tsx that hid 371 lines, including
// the element one of these rules asserts on. See code-without-comments.
const code = codeWithoutComments;

const layout = code(readFileSync(LAYOUT, "utf8"));
const tabs = code(readFileSync(TABS, "utf8"));

/** className strings in a file, as whole-token lists. */
function classLists(src: string): string[][] {
  return [...src.matchAll(/className="([^"]+)"/g)].map((m) => m[1].split(/\s+/));
}

describe("project chrome is one band", () => {
  it("found both files with real markup", () => {
    // Positive control: a rename would otherwise make every rule below vacuous.
    expect(classLists(layout).length).toBeGreaterThan(3);
    expect(classLists(tabs).length).toBeGreaterThan(3);
    expect(layout).toContain("<ProjectBoardTabs");
  });

  it("renders the tab strip exactly once", () => {
    // Merging the bands by hand once left the OLD standalone strip in place as
    // well, so the page had two. tsc did not mind; nothing else would have.
    expect(layout.match(/<ProjectBoardTabs/g) ?? []).toHaveLength(1);
  });

  it("the tab strip does not own a band", () => {
    // `border-b` or its own horizontal padding here means it is drawing a
    // second band inside the one the layout already draws.
    const roots = classLists(tabs).filter((c) => c.includes("overflow-x-auto"));
    expect(roots.length).toBeGreaterThan(0);
    for (const c of roots) {
      expect(c).not.toContain("border-b");
      expect(c).not.toContain("px-4");
      // What keeps the scroll inside the strip instead of shoving the actions out.
      expect(c).toContain("min-w-0");
      expect(c).toContain("flex-1");
    }
  });

  it("the layout draws one band holding identity, tabs and actions", () => {
    const bands = classLists(layout).filter((c) => c.includes("border-b"));
    // The classification banner is a separate component; within this file the
    // project chrome is one bordered row.
    expect(bands).toHaveLength(1);
    expect(bands[0]).toContain("items-center");
  });

  it("keeps the project name a heading", () => {
    // journey-create-project.spec.ts asserts a heading named after the project,
    // and the board page renders no title of its own -- this is the only one.
    expect(layout).toMatch(/<h1[^>]*>\{project\.name\}<\/h1>/);
  });

  it("keeps the project actions reachable by their accessible names", () => {
    // Four e2e journeys click these. They moved; they must not have been renamed.
    expect(layout).toContain("Intervals");
    expect(layout).toContain('aria-label="Project settings"');
  });
});
