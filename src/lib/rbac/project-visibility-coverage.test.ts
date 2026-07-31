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

/**
 * Reaches across more than one project: could disclose their identity — OR, just
 * as tellingly, their NUMBER.
 *
 * `count` is here because of the fifth leak. The list was correctly narrowed and
 * the header still read the full org total, so a non-member was told exactly how
 * much they were not being shown. A count is not a lesser disclosure than a
 * list, and this guard only looked for `findMany`, so it had nothing to say.
 */
const ENUMERATES = /prisma\.project\.(findMany|count|aggregate|groupBy)/;

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

/**
 * Lines around a call that an exemption for it would plausibly live in.
 *
 * Checked PER OCCURRENCE, not per file — which is the whole lesson of the fifth
 * leak. `cache/queries.ts` opens with a SCOPING NOTE covering
 * `getActiveProjectsForOrg` (legitimately: its callers narrow the cached
 * result). A file-level check treated that as absolution for the ENTIRE file,
 * so when an unnarrowed project COUNT was later added further down, it silently
 * inherited an exemption written about a different function and this guard said
 * nothing. A note has to sit with the thing it excuses.
 */
// Asymmetric on purpose: the normal shape is fetch-then-filter
// (`const all = await findMany(...)` … `getVisibleProjectIds(ctx, all)`), so the
// narrowing almost always sits BELOW the query, sometimes a good way below.
// A note explaining an exemption, by contrast, sits directly above it.
const BEFORE = 15;
const AFTER = 45;

/**
 * `where: { id: { in: [...] } }` is HYDRATION, not enumeration.
 *
 * The caller already holds the ids — they came from a work-item list or a search
 * result that was itself scoped — and is only resolving keys and names for them.
 * Such a call cannot widen what the actor sees, so demanding a narrowing helper
 * there would be noise, and noise is how a guard stops being read.
 *
 * What this gate is actually about is the org-wide sweep: "give me the projects
 * in this org", whose answer depends entirely on who is asking.
 */
const HYDRATES_BY_ID = /id:\s*\{\s*in:/;

function unnarrowedCalls(src: string): number[] {
  const lines = src.split("\n");
  const bad: number[] = [];
  lines.forEach((line, i) => {
    if (!ENUMERATES.test(line)) return;
    // The call's own argument object, where the `where:` clause lives.
    const args = lines.slice(i, i + 8).join("\n");
    if (HYDRATES_BY_ID.test(args)) return;
    const window = lines.slice(Math.max(0, i - BEFORE), i + AFTER + 1).join("\n");
    if (!NARROWS.test(window)) bad.push(i + 1);
  });
  return bad;
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
    const offenders = ROOTS.flatMap((r) => walk(r)).flatMap((f) => {
      const lines = unnarrowedCalls(readFileSync(f, "utf8"));
      return lines.map((n) => `${f}:${n}`);
    });

    expect(
      offenders,
      "these enumerate or COUNT projects without narrowing to what the actor may " +
        "see. Filter with getVisibleProjectIds / visibleProjectIdsForActor, or put " +
        "a `SCOPING NOTE` comment NEXT TO THE CALL saying why it is exempt — a note " +
        "elsewhere in the file does not carry.",
    ).toEqual([]);
  });

  it("would catch a note that sits in the wrong place (guards the guard)", () => {
    // The exact shape that leaked: a legitimate exemption at the top of a file,
    // and an unnarrowed call far below it that never earned one.
    const far = ["// SCOPING NOTE — about something else entirely.", ...Array(60).fill("//")].join("\n");
    expect(unnarrowedCalls(`${far}\nconst n = await prisma.project.count();`)).toEqual([62]);
    // …and that a note beside the call still exempts it.
    expect(
      unnarrowedCalls("// SCOPING NOTE — org-wide by design.\nconst n = await prisma.project.count();"),
    ).toEqual([]);
  });
});
