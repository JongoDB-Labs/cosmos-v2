import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every PM register must label its branch picker through `branchOptions`.
 *
 * `branchLabel` was correct from the day it landed, and its unit test passed the
 * whole time — but each register renders the branch picker TWICE (an `options`
 * array on the inline-edit field, and `SelectItem`s in the create dialog) and
 * only the inline-edit half was converted. All four registers went on offering
 * "LOE1 LOE 1 — Authorize, Cloud & Data" in the create dialog on production,
 * because a unit test on the helper cannot see whether the call sites use it.
 *
 * So this asserts the CALL SITES, not the helper: no register may interpolate
 * `code` and `name` itself. A fifth register added later, or a revert of any of
 * the eight sites, fails here.
 */

const PM_DIR = "src/components/pm-dashboard";

// `{b.code} {b.name}`, `{br.code}{" "}{br.name}`, `${b.code} ${b.name}` — any
// shape that pairs a branch code with its name outside branchOptions.
const RAW_CONCAT =
  /\{\s*(\w+)\.code\s*\}[\s\S]{0,20}?\{\s*\1\.name\s*\}|\$\{\s*(\w+)\.code\s*\}[^`]{0,20}?\$\{\s*\2\.name\s*\}/;

function pmFiles(): string[] {
  return readdirSync(PM_DIR)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => join(PM_DIR, f));
}

describe("PM branch pickers label through branchOptions", () => {
  it("no register interpolates a branch code and name itself", () => {
    const offenders = pmFiles().filter((f) =>
      RAW_CONCAT.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("every register that offers a branch picker imports branchOptions", () => {
    // Guards the other direction: a register could avoid the raw-concat pattern
    // and still hand-roll a label some third way.
    const usingBranches = pmFiles().filter((f) => {
      const src = readFileSync(f, "utf8");
      return /branches\s*[:,)]/.test(src) && /SelectValue placeholder="Select branch"/.test(src);
    });
    expect(usingBranches.length).toBeGreaterThan(0); // not vacuous
    for (const f of usingBranches) {
      expect(readFileSync(f, "utf8"), `${f} builds a branch picker`).toContain(
        "branchOptions",
      );
    }
  });

  it("scanned the real register files", () => {
    // A rename or move of pm-dashboard/ must fail loudly rather than silently
    // scanning nothing and reporting success.
    const names = pmFiles().map((f) => f.split("/").pop());
    expect(names).toContain("change-tracker.tsx");
    expect(names).toContain("blocker-tracker.tsx");
    expect(names).toContain("deliverable-tracker.tsx");
    expect(names).toContain("schedule-tracker.tsx");
  });
});
