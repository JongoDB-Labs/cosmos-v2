// `src/lib/pm/export.ts` exports exactly one thing: the workbook builder.
//
// This pins a module surface rather than scanning for reachability, because the
// reachability rule in `exports-are-reachable.arch.test.ts` deliberately cannot
// catch what happened here — and the gap is worth a comment, since the obvious
// reading is that the other test already covers this file.
//
// That rule treats a declaration as reachable if it is referenced inside its own
// module, which is right for a type that annotates the module's internals. But
// `ExportTracker` was exported, imported by nobody, and referenced twice inside
// export.ts — by the `trackers?: ExportTracker[]` parameter nothing ever passed
// and the `want()` helper that parameter existed to drive. Three dead names
// holding each other up: each one's only use was another one, so the whole
// cluster read as reachable. Verified before deleting it — restoring the
// pre-cleanup export.ts leaves the reachability test green at 3/3.
//
// A behavioural test cannot cover this either. `want()` returned true for every
// register on every call, so the workbook had all eight sheets before and after;
// and JS ignores surplus arguments, so arity proves nothing. Dead code that was
// genuinely dead is invisible to a test of behaviour — the thing that changed is
// the surface, so the surface is what gets asserted.
//
// The SharePoint upload route is the only production caller and wants only
// `buildProjectWorkbook`. Adding a second export here means either a new caller
// (update this list) or another passenger (don't).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const EXPORT_MODULE = "src/lib/pm/export.ts";

/** Top-level exported declaration names, in source order. */
function exportedNames(path: string): string[] {
  const src = readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  return [
    ...src.matchAll(
      /^export\s+(?:async\s+)?(?:declare\s+)?(?:interface|type|enum|const|let|function|class)\s+(\w+)/gm,
    ),
  ].map((m) => m[1]);
}

describe("src/lib/pm/export.ts public surface", () => {
  it("scanned the real module", () => {
    // Guards the regex, not the rule: if the pattern stopped matching, the
    // assertion below would pass on an empty list and prove nothing.
    const src = readFileSync(EXPORT_MODULE, "utf8");
    expect(src).toContain("buildProjectWorkbook");
    expect(exportedNames(EXPORT_MODULE).length).toBeGreaterThan(0);
  });

  it("exports only buildProjectWorkbook", () => {
    expect(exportedNames(EXPORT_MODULE)).toEqual(["buildProjectWorkbook"]);
  });
});
