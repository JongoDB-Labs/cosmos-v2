// @vitest-environment node
//
// Every Sprint Health widget must have a grid position at every breakpoint.
//
// WHY THIS IS A SOURCE-LEVEL TEST. `dashboard-view.test.tsx` MOCKS
// react-grid-layout (it needs real layout, which jsdom does not provide) and
// asserts against the mobile stack. So the desktop grid — and `DEFAULT_LAYOUTS`
// — is exercised by nothing at all. A widget added to `widgetDefs` without a
// matching layout entry still renders and still passes every test; react-grid-
// layout just gives it a default cell at the origin, where it collapses to an
// unreadable sliver stacked under whatever else landed there.
//
// That is not hypothetical. "Work Type Mix" (2.288.0) and "Blocked Work"
// (2.290.0) both reached production looking broken this way, and both were
// found by looking at the screen rather than by a test. This is the test that
// would have caught them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join("src", "components", "boards", "dashboard", "dashboard-view.tsx"),
  "utf8",
);

/** Widget keys, from the `widgetDefs` array's `key:` fields. */
function widgetKeys(): string[] {
  const start = SOURCE.indexOf("const widgetDefs");
  expect(start, "widgetDefs no longer exists — update this test").toBeGreaterThan(-1);
  // Up to the closing of the array literal, marked by the render that follows.
  const end = SOURCE.indexOf("const HEALTH_VIEWS", start);
  const block = SOURCE.slice(start, end === -1 ? undefined : end);
  return [...block.matchAll(/^\s{4,6}key:\s*"([a-z-]+)"/gm)].map((m) => m[1]);
}

/** `{ i: "..." }` entries per breakpoint in DEFAULT_LAYOUTS. */
function layoutKeys(): Record<string, string[]> {
  const start = SOURCE.indexOf("const DEFAULT_LAYOUTS");
  expect(start, "DEFAULT_LAYOUTS no longer exists — update this test").toBeGreaterThan(-1);
  const block = SOURCE.slice(start, SOURCE.indexOf("\n};", start));

  const out: Record<string, string[]> = {};
  for (const bp of ["lg", "md", "sm"]) {
    const bpStart = block.indexOf(`${bp}: [`);
    if (bpStart === -1) continue;
    const bpBlock = block.slice(bpStart, block.indexOf("],", bpStart));
    out[bp] = [...bpBlock.matchAll(/\{\s*i:\s*"([a-z-]+)"/g)].map((m) => m[1]);
  }
  return out;
}

describe("every widget has a grid position at every breakpoint", () => {
  it("finds the widgets and the layouts at all", () => {
    // A parser that silently matches nothing would make every assertion below
    // vacuously true — the exact failure mode this file exists to prevent.
    const keys = widgetKeys();
    const layouts = layoutKeys();
    expect(keys.length).toBeGreaterThan(5);
    expect(Object.keys(layouts).sort()).toEqual(["lg", "md", "sm"]);
    for (const bp of Object.keys(layouts)) {
      expect(layouts[bp].length, `${bp} parsed no entries`).toBeGreaterThan(5);
    }
  });

  it("positions every widget in every breakpoint", () => {
    const keys = widgetKeys();
    const layouts = layoutKeys();

    for (const [bp, placed] of Object.entries(layouts)) {
      const missing = keys.filter((k) => !placed.includes(k));
      expect(
        missing,
        `${bp} has no position for ${missing.join(", ")} — react-grid-layout will ` +
          `collapse ${missing.length === 1 ? "it" : "them"} to a 1x1 cell at the origin`,
      ).toEqual([]);
    }
  });

  it("has no layout entry for a widget that no longer exists", () => {
    // A stale entry is harmless to render but it is a lie about the layout, and
    // it is how the array drifts out of step with the board.
    const keys = widgetKeys();
    for (const [bp, placed] of Object.entries(layoutKeys())) {
      const orphans = placed.filter((p) => !keys.includes(p));
      expect(orphans, `${bp} positions widgets that do not exist`).toEqual([]);
    }
  });

  it("does not stack two widgets on the same origin cell", () => {
    // Two widgets at the same (x, y) overlap. The compactor resolves most
    // collisions, but an exact duplicate origin is always an authoring mistake.
    const start = SOURCE.indexOf("const DEFAULT_LAYOUTS");
    const block = SOURCE.slice(start, SOURCE.indexOf("\n};", start));
    for (const bp of ["lg", "md", "sm"]) {
      const bpStart = block.indexOf(`${bp}: [`);
      const bpBlock = block.slice(bpStart, block.indexOf("],", bpStart));
      const cells = [...bpBlock.matchAll(/i:\s*"([a-z-]+)",\s*x:\s*(\d+),\s*y:\s*(\d+)/g)].map(
        (m) => ({ key: m[1], at: `${m[2]},${m[3]}` }),
      );
      const seen = new Map<string, string>();
      for (const c of cells) {
        expect(
          seen.get(c.at),
          `${bp}: ${c.key} sits on the same cell as ${seen.get(c.at)}`,
        ).toBeUndefined();
        seen.set(c.at, c.key);
      }
    }
  });
});
