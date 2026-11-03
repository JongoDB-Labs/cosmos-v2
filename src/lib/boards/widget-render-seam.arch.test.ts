// The widget render seam keeps its two ends.
//
// `widget-registry.ts` existed with ZERO references outside its own file for as
// long as the board builder has shipped, and `Board.config.widgets` had exactly
// one reader — the builder reloading its own state. So the builder saved
// layouts that nothing in the product could ever display. Nothing failed: the
// registry type-checked, its tests (there were none) would have passed, and the
// gap was an ABSENCE, which does not appear in a diff.
//
// These are facts about CALL SITES, which is why they cannot be unit tests of
// the registry. A unit test of `WidgetRegistry.register`/`get` passed happily
// the entire time the seam was dead.
//
// Comments are stripped before scanning and a CALL is required, not a mention:
// this very file names `WidgetRegistry.register` in prose above, and a naive
// `includes("WidgetRegistry.register")` over the source would be satisfied by
// the explanation of the bug rather than by the fix (see memory:
// a-loose-assertion-is-a-false-green, "the guard matched its own explanation").
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BOARD_TYPE_REGISTRY } from "./board-types";

const SRC = "src";
/** The seam's own definition — where these names may appear without a caller. */
const REGISTRY_FILE = join(SRC, "lib", "boards", "widget-registry.ts");
const DATA_FILE = join(SRC, "lib", "boards", "widget-data.ts");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
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

const isTest = (f: string) => /\.(test|spec)\.(ts|tsx)$/.test(f);

const PRODUCTION = walk(SRC)
  .filter((f) => !isTest(f))
  .map((file) => ({ file, src: code(readFileSync(file, "utf8")) }));

/** Files that CALL `name(` — a call, never a mention. */
function callers(name: string, exclude: string[] = []): string[] {
  const call = new RegExp(`\\b${name.replace(".", "\\.")}\\s*\\(`);
  return PRODUCTION.filter(
    (f) => !exclude.includes(f.file) && call.test(f.src),
  ).map((f) => f.file);
}

describe("the widget render seam", () => {
  it("scanned a realistic amount of source", () => {
    // Positive control. A walk that found nothing would make every rule below
    // vacuously true, which is the exact failure mode this file exists to stop
    // one layer down.
    expect(PRODUCTION.length).toBeGreaterThan(500);
  });

  it("strips comments, so prose about the seam cannot satisfy these rules", () => {
    // The control on the control. THIS file's own header names
    // `WidgetRegistry.register` in a comment; if the stripper were a no-op the
    // rules would pass against a codebase that only talks about the seam.
    const stripped = code(
      `// WidgetRegistry.register(fake)\n/* WidgetRegistry.get(fake) */\nconst x = 1;`,
    );
    expect(stripped).not.toMatch(/WidgetRegistry\.register\s*\(/);
    expect(stripped).not.toMatch(/WidgetRegistry\.get\s*\(/);
    expect(stripped).toContain("const x = 1;");
  });

  it("something REGISTERS into the registry", () => {
    const who = callers("WidgetRegistry.register", [REGISTRY_FILE]);
    expect(
      who,
      "nothing registers a widget component: every saved widget would render " +
        "the 'not available' tile, and the registry would be dead again",
    ).not.toEqual([]);
  });

  it("something READS out of the registry", () => {
    const who = callers("WidgetRegistry.get", [REGISTRY_FILE]);
    expect(
      who,
      "nothing looks a widget up: registering components would reach no screen",
    ).not.toEqual([]);
  });

  it("a BOARD VIEW reads Board.config.widgets", () => {
    // The deepest claim, and the one the original defect violated. The reader
    // must live under `components/boards` — the builder reloading its own saved
    // state is not a consumer, it is the writer reading itself back.
    const who = callers("readBuilderWidgets", [DATA_FILE]).filter((f) =>
      f.startsWith(join(SRC, "components", "boards")),
    );
    expect(
      who,
      "no board view reads the saved widget layout — the builder would be " +
        "writing to a key with no renderer, which is how this shipped from the " +
        "original import (53cbcf5f) until 2.511.x",
    ).not.toEqual([]);
  });

  it("`rendersSavedWidgets` names exactly the types that render DashboardView", () => {
    // The registry flag is what gates the builder's entry point. It is a claim
    // ABOUT ANOTHER FILE — `BOARD_VIEWS` in `board-renderer.tsx` — and nothing
    // else connects the two, so a fourth board type pointed at `DashboardView`
    // would silently render widgets with no way to edit them, and a view
    // swapped away from `DashboardView` would keep offering a builder whose
    // output it no longer draws. That is the four-unlinked-lists problem
    // `BOARD_TYPE_REGISTRY` was created to end; this is the link for this fact.
    const renderer = readFileSync(
      join(
        SRC,
        "app",
        "(dashboard)",
        "[orgSlug]",
        "projects",
        "[projectKey]",
        "boards",
        "[boardId]",
        "board-renderer.tsx",
      ),
      "utf8",
    );
    // `TYPE: (p) => <DashboardView … />`, from the BOARD_VIEWS record.
    const drawsDashboard = [
      ...code(renderer).matchAll(
        /^\s{2}([A-Z_]+):\s*\(p\)\s*=>\s*<DashboardView\b/gm,
      ),
    ].map((m) => m[1]);

    // Positive control: a regex that matched nothing would make the comparison
    // below pass only if the flag were set nowhere either — two wrongs reading
    // as a right.
    expect(
      drawsDashboard.length,
      "parsed no DashboardView entries out of BOARD_VIEWS — update this test",
    ).toBeGreaterThan(0);

    const flagged = Object.entries(BOARD_TYPE_REGISTRY)
      .filter(([, def]) => def.rendersSavedWidgets)
      .map(([type]) => type);

    expect(flagged.sort()).toEqual(drawsDashboard.sort());
  });

  it("the register call is made by a FUNCTION, not an import side effect", () => {
    // `registerBoardWidgets()` is deliberately a function the renderer calls,
    // because an import kept only for its side effect is what bundlers, HMR and
    // dead-code elimination drop — and the symptom (a board of "not available"
    // tiles) would have nothing in the diff to explain it.
    const seam = PRODUCTION.find((f) =>
      f.file.endsWith(join("dashboard", "widget-grid.tsx")),
    );
    expect(seam, "widget-grid.tsx is gone — update this test").toBeTruthy();
    expect(seam!.src).toMatch(/registerBoardWidgets\s*\(\s*\)/);
  });
});
