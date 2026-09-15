import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A sector template must not ship BOTH roadmap surfaces.
 *
 * There are two unrelated things in this product called "Roadmap", and they
 * render in the same project tab strip under the same label:
 *
 *   - the ROADMAP **board** — an Epics x Increments grid of WORK ITEMS
 *     (`components/boards/roadmap/roadmap-view.tsx`), created from a board template
 *   - the "roadmap" **module** — the RoadmapNode workspace at /projects/{key}/roadmap
 *     (`components/roadmap/roadmap-workspace.tsx`), switched on by an entry in
 *     `enabledFeatures`
 *
 * The software template shipped both, so every Software project opened with two
 * tabs named "Roadmap" showing entirely different things — and the module one is
 * always empty, because nothing in the product UI creates a RoadmapNode.
 *
 * The origin was a wrong comment claiming the BOARD's filters were "keyed to
 * roadmap nodes rather than work items". They are not. A reader who believes that
 * will reach for the feature flag again, which is why this is a test and not a
 * comment.
 *
 * Scans source rather than importing: these templates are inline consts inside
 * seed functions, not exported data.
 *
 * Lives under src/ because vitest's `include` covers src/** and a few scripts/
 * dirs — NOT prisma/**. Written there first, it silently never ran.
 */

const SECTORS_DIR = "prisma/seed/sectors";

function sectorFiles(): string[] {
  return readdirSync(SECTORS_DIR).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );
}

/** Strip comments — this file's own explanation names both offending strings. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("sector templates do not ship two Roadmap tabs", () => {
  it("scanned the real sector files, so a rename fails loudly", () => {
    const files = sectorFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain("software.ts");
  });

  for (const file of sectorFiles()) {
    it(`${file} does not enable the roadmap module alongside a ROADMAP board`, () => {
      const src = stripComments(readFileSync(join(SECTORS_DIR, file), "utf8"));

      const hasRoadmapBoard = /boardType:\s*"ROADMAP"/.test(src);
      // The feature key as it appears in an enabledFeatures list.
      const hasRoadmapModule = /"roadmap"\s*,/.test(src);

      expect(
        hasRoadmapBoard && hasRoadmapModule,
        `${file} ships a ROADMAP board AND the "roadmap" feature flag — a project ` +
          `created from it gets two tabs both labelled "Roadmap". Pick one.`,
      ).toBe(false);
    });
  }
});
