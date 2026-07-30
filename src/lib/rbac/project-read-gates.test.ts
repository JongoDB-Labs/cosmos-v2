import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the CLASS, not the 46 instances.
 *
 * Every route under projects/[projectId] that reads project-owned data must go
 * through `requireProjectRead`, which layers team scoping onto the action bit.
 * A bare `requirePermission(ctx, Permission.X_READ)` checks an ORG-WIDE bit and
 * says nothing about whether the actor may see THIS project — which is how
 * team-scoped access came to hold on the org-wide Issues list and nowhere else.
 *
 * Converting 46 routes is worth little if the 47th reintroduces the pattern, so
 * this fails on any new one rather than trusting a convention to be remembered.
 */

const ROUTES_DIR = "src/app/api/v1/orgs/[orgId]/projects/[projectId]";

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...routeFiles(p));
    else if (e.name === "route.ts") out.push(p);
  }
  return out;
}

/** `requirePermission(ctx, Permission.SOMETHING_READ)` — the pattern replaced. */
const RAW_READ_GATE = /requirePermission\((?:r\.)?ctx,\s*Permission\.[A-Z_]+_READ\)/;

describe("project-scoped read gates", () => {
  it("finds the route files at all (guards the scan itself)", () => {
    // Without this, a directory move would make every assertion below vacuous:
    // an empty scan trivially passes.
    const files = routeFiles(ROUTES_DIR);
    expect(files.length).toBeGreaterThan(30);
  });

  it("routes the whole project subtree through requireProjectRead", () => {
    const offenders = routeFiles(ROUTES_DIR).filter((f) =>
      RAW_READ_GATE.test(readFileSync(f, "utf8")),
    );

    // Named so a failure says WHICH route and WHY, not just "expected 0".
    expect(
      offenders,
      "these gate reads on an org-wide permission bit with no project scoping — " +
        "use requireProjectRead(ctx, projectId, ACTION) instead",
    ).toEqual([]);
  });
});
