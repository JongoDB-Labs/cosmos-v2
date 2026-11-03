// A type is savable from a view exactly when its view honours the saved filter.
//
// "Save as board" writes the view's filter into `Board.config.query`, and
// `boardBaseline()` (boards/shared/use-board-query) reads it back on load. So
// marking a type `savableFromView` without its view reading that baseline
// produces the worst kind of control: the dialog accepts your filter, creates
// the board, and the board ignores it. That is the silent-empty-filter shape
// again — a control that looks like it worked.
//
// This ties the flag to the mechanism so the two cannot drift. It is why the
// list grew from two to eleven with confidence rather than by taste: eight
// views already called `useBoardQuery` and only two were on offer.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BOARD_TYPE_REGISTRY, BOARD_TYPE_ORDER } from "./board-types";

const RENDERER =
  "src/app/(dashboard)/[orgSlug]/projects/[projectKey]/boards/[boardId]/board-renderer.tsx";

/** Component name -> the file that defines it, from the renderer's imports. */
function importedFrom(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/import \{ ([^}]+) \} from "([^"]+)"/g)) {
    for (const name of m[1].split(",").map((n) => n.trim().replace(/^type /, ""))) {
      if (name) out.set(name, m[2]);
    }
  }
  for (const m of src.matchAll(/import \{ ([^}]+) \} from\s*\n?\s*"([^"]+)"/g)) {
    for (const name of m[1].split(",").map((n) => n.trim())) if (name) out.set(name, m[2]);
  }
  return out;
}

function resolve(spec: string): string | null {
  if (!spec.startsWith("@/")) return null;
  return `src/${spec.slice(2)}.tsx`;
}

/**
 * Types whose baseline-reading component is not the first one the renderer
 * mentions, with the component that actually applies for a SAVED board.
 *
 * SCRUM renders SprintBoard, which wraps KanbanBoard — and KanbanBoard fetches
 * the board (config included) and runs `useBoardQuery` itself.
 *
 * TIMELINE's entry forks on `config.mode === "release-timeline"`, and the
 * release-timeline variant reads no baseline at all. That is not a gap: only
 * the built-in template sets that mode, and "Save as board" never does, so a
 * board created from a filter is always the Gantt. Worth stating here because
 * the first component in that branch is the one that would NOT honour a
 * filter, and reading the renderer naively says the opposite.
 */
const PRIMARY_VIEW: Record<string, string> = {
  SCRUM: "KanbanBoard",
  TIMELINE: "TimelineView",
};

const renderer = readFileSync(RENDERER, "utf8");
const imports = importedFrom(renderer);

/** The component each BoardType renders, from BOARD_VIEWS. */
function componentFor(type: string): string | null {
  const m = renderer.match(new RegExp(`\\n  ${type}: \\(p\\) =>[\\s\\S]{0,160}?<([A-Z][A-Za-z]+)`));
  return m ? m[1] : null;
}

function readsBaseline(component: string): boolean | null {
  const file = resolve(imports.get(component) ?? "");
  if (!file) return null;
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return /useBoardQuery/.test(src);
}

describe("savableFromView honours the saved filter", () => {
  it("resolves every type to a component", () => {
    // Positive control: a regex that stopped matching would make the rules
    // below vacuous rather than failing.
    const unresolved = BOARD_TYPE_ORDER.filter((t) => !componentFor(t));
    expect(unresolved).toEqual([]);
  });

  it("every savable type's view reads the baseline", () => {
    const offenders: string[] = [];
    for (const type of BOARD_TYPE_ORDER) {
      if (!BOARD_TYPE_REGISTRY[type].savableFromView) continue;
      const component = PRIMARY_VIEW[type] ?? componentFor(type)!;
      if (readsBaseline(component) !== true) offenders.push(`${type} -> ${component}`);
    }
    expect(offenders).toEqual([]);
  });

  it("no non-savable type's view reads it, so nothing savable is being withheld", () => {
    // The other direction, and the one that found the original gap: a view that
    // already honours a filter but cannot be created from one is a capability
    // sitting behind a flag.
    const withheld: string[] = [];
    for (const type of BOARD_TYPE_ORDER) {
      if (BOARD_TYPE_REGISTRY[type].savableFromView) continue;
      const component = PRIMARY_VIEW[type] ?? componentFor(type)!;
      if (readsBaseline(component) === true) withheld.push(`${type} -> ${component}`);
    }
    expect(withheld).toEqual([]);
  });
});
