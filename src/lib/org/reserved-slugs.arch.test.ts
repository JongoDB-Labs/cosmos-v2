// @vitest-environment node
//
// An org's slug is the first segment of its URLs, and Next.js matches a real
// top-level route before the dynamic [orgSlug]. So every top-level route must be
// a reserved slug, or an org can take a name whose pages it can never reach.
// The list is kept by hand; this reads the routes so it can't fall behind.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isReservedSlug } from "./reserved-slugs";

const APP = join(process.cwd(), "src/app");

function hasRoute(dir: string): boolean {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (hasRoute(join(dir, e.name))) return true;
    } else if (/^(page|route)\.tsx?$/.test(e.name)) return true;
  }
  return false;
}

// Top-level URL segments: directories of src/app and of its route groups,
// leaving out dynamic segments, private folders and tests.
function topSegments(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (/^\(.+\)$/.test(e.name)) out.push(...topSegments(join(dir, e.name)));
    else if (!/^[[_]/.test(e.name) && hasRoute(join(dir, e.name))) out.push(e.name);
  }
  return out;
}

describe("reserved org slugs", () => {
  const segments = topSegments(APP);

  it("finds the app's top-level routes", () => {
    expect(existsSync(join(APP, "login"))).toBe(true);
    expect(segments).toContain("login");
    expect(segments).toContain("api");
    // ...and those inside route groups: (developers)/developers, (dashboard)/admin.
    expect(segments).toContain("developers");
    expect(segments).toContain("admin");
  });

  it("reserve every top-level route", () => {
    expect(segments.filter((s) => !isReservedSlug(s))).toEqual([]);
  });
});
