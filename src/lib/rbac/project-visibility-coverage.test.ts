import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the CLASS that kept escaping.
 *
 * teamScopedAccess has now leaked four separate times, each in a place the
 * previous sweep had no reason to look:
 *
 *   1. the projects LIST      — one directory above the routes I converted
 *   2. portfolio analytics    — a different route family
 *   3. the project PAGES      — server components, not routes at all
 *   4. Issues / facets / activity / @-mentions / the AI tools
 *                             — a second, older helper that predated the flag
 *
 * Every previous guard was written against the shape of the fix I had just
 * made, so it could only catch a repeat of that shape. This one is written
 * against the CAPABILITY instead: any code that enumerates projects and can
 * hand back their identity must narrow that list, or say why it does not.
 *
 * Opting out is deliberate and cheap — a SCOPING NOTE comment — so the answer
 * is recorded rather than assumed.
 */

const ROOTS = ["src/app", "src/lib"];

/** Enumerates projects: could return more than one project's identity. */
const ENUMERATES = /prisma\.project\.findMany/;

/** Any of the sanctioned ways to narrow, or an explicit written exemption. */
const NARROWS =
  /getVisibleProjectIds|visibleProjectIdsForActor|canReadProject|isProjectVisible|getReadableProjectIds|SCOPING NOTE/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) out.push(p);
  }
  return out;
}

describe("project enumeration is narrowed everywhere, or exempted in writing", () => {
  it("finds source files at all (guards the scan itself)", () => {
    const files = ROOTS.flatMap((r) => walk(r));
    expect(files.length).toBeGreaterThan(200);
    // …and that the pattern still matches something, so a rename of the Prisma
    // call cannot make this vacuously green.
    expect(files.filter((f) => ENUMERATES.test(readFileSync(f, "utf8"))).length).toBeGreaterThan(3);
  });

  it("has no unnarrowed, unexplained project enumeration", () => {
    const offenders = ROOTS.flatMap((r) => walk(r)).filter((f) => {
      const src = readFileSync(f, "utf8");
      return ENUMERATES.test(src) && !NARROWS.test(src);
    });

    expect(
      offenders,
      "these enumerate projects without narrowing to what the actor may see. " +
        "Filter with getVisibleProjectIds / visibleProjectIdsForActor, or add a " +
        "`SCOPING NOTE` comment saying why this surface is exempt.",
    ).toEqual([]);
  });
});
