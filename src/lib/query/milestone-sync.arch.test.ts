import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { milestoneInvalidations } from "./milestone-keys";

/**
 * A milestone write must invalidate BOTH projections of the milestone table.
 *
 * `/milestones` (Milestones board, Release Timeline) and `/schedule` (PM
 * Dashboard) read and write the same `prisma.milestone` rows through different
 * endpoints, cached under different keys. Every write site invalidated only its
 * own key, so a milestone created or edited on one screen left the other
 * showing the stale row until a reload — reported as milestones not syncing
 * bidirectionally between the milestones board and other boards.
 *
 * Sharing ONE cache key would be wrong: the two projections have different
 * shapes and would overwrite each other's fields. Invalidating both is the
 * correct expression, so the rule this asserts is "name one, name the other".
 */

const ROOTS = ["src/components", "src/hooks"];

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const MILESTONES_KEY = /\["milestones"\s*,/;
const SCHEDULE_KEY = /\["schedule"\s*,/;

describe("milestone cache invalidation covers both projections", () => {
  const files = ROOTS.flatMap(tsxFiles);

  it("scanned a real tree", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.includes("milestones-timeline"))).toBe(true);
    expect(files.some((f) => f.includes("schedule-tracker"))).toBe(true);
  });

  it("no component names one milestone cache key without the other", () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      const hasMilestones = MILESTONES_KEY.test(src);
      const hasSchedule = SCHEDULE_KEY.test(src);
      if (!hasMilestones && !hasSchedule) return false;
      // Routing through the shared helper satisfies both by construction.
      if (src.includes("milestoneInvalidations")) return false;
      return hasMilestones !== hasSchedule;
    });
    expect(offenders).toEqual([]);
  });

  it("the helper lists both keys, scoped to the project", () => {
    // Guards the helper itself: dropping a key here would silently satisfy the
    // scan above while restoring the original bug everywhere at once.
    expect(milestoneInvalidations("p1")).toEqual([
      ["milestones", "p1"],
      ["schedule", "p1"],
    ]);
  });

  it("both write surfaces route through the helper", () => {
    for (const f of [
      "src/components/milestones/milestones-timeline.tsx",
      "src/components/pm-dashboard/schedule-tracker.tsx",
      "src/components/files/files-workspace.tsx",
    ]) {
      expect(readFileSync(f, "utf8"), `${f} must invalidate both`).toContain(
        "milestoneInvalidations(projectId)",
      );
    }
  });
});
