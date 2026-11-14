import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Picking "the active interval" must EXCLUDE Program Increments.
 *
 * THIS DEFECT HAS NOW SHIPPED THREE TIMES, in three different layers, from the
 * same one-line shape:
 *
 *   intervals.find((i) => i.status === "ACTIVE")            // ceremony boards
 *   intervals.find((s) => s.status === "ACTIVE")            // Sprint Health burndown
 *   prisma.interval.findFirst({ where: { status: "ACTIVE" }})  // the AI sprint brief
 *
 * Two facts make it wrong in the NORMAL case, not an edge one:
 *
 *   - a PI is ACTIVE for exactly as long as any sprint inside it is running, so
 *     it matches `status === "ACTIVE"` whenever a sprint does;
 *   - the intervals API orders by `number` DESC and a PI is numbered above its
 *     sprints, so it also sorts FIRST.
 *
 * So in a healthy project the container both matches and sorts first — and it
 * holds no work items of its own, so whatever consumed it reported 0 items and
 * 0 points. The symptom is never "wrong interval"; it is an empty chart, an
 * empty brief, or a review that says the team delivered nothing.
 *
 * A unit test of the picker cannot catch this: `defaultCeremonyInterval` has
 * been correct since 2.286.1. The bug is always a caller that does not use it.
 * That is this codebase's signature defect — a correct rule with one call site —
 * so the guard has to be at the source level, over call sites.
 */

const ROOTS = ["src/components", "src/lib", "src/app"];

/**
 * Files reviewed and permitted to match. Each needs a REASON, and the second
 * test below fails when an entry stops matching, so this list cannot rot into
 * a silent blanket exemption.
 */
const ALLOWED: Record<string, string> = {
  // The picker itself — it filters PIs out first, which is the whole point.
  "src/lib/intervals/ceremony-intervals.ts":
    "defines the rule: filters Program Increments before finding the ACTIVE one",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|mts)$/.test(p) && !/\.test\.(ts|tsx|mts)$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * An in-memory `.find`/`.filter` on ACTIVE status. Matches the shape regardless
 * of the callback's parameter name, which is how the three copies differed.
 */
const IN_MEMORY = /\.(find|filter)\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.status\s*===\s*["']ACTIVE["']/;

/** A Prisma interval query filtering on ACTIVE. */
const PRISMA_INTERVAL = /prisma\.interval\.(findFirst|findMany)\(/;

/**
 * Source with its comments removed. The rules below look for words that
 * exclude a PI ("PROGRAM_INCREMENT", "intervalKind"), and the files that once
 * had this bug explain the fix in a comment that uses those words. Read whole,
 * a file passed on the comment alone: `update_interval` did, with its own
 * check counting a running PI as a competitor. Code only, then.
 */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/**
 * Does this source find an ACTIVE interval in memory without excluding PIs?
 * Permitted when the file goes through the shared picker, or filters the
 * container out itself.
 *
 * `intervalKind` counts as narrowing, so a file that filters kinds itself is
 * not an offender. NOTE that an allowlist (`kind === "SPRINT"`) is weaker than
 * excluding the container — sprint-board.tsx does this and falls back to ALL
 * intervals when a project runs no SPRINTs, which puts the PI back in the
 * pool. Milder than the bug this guards, but real.
 */
function inMemoryOffender(source: string): boolean {
  const src = stripComments(source);
  if (!IN_MEMORY.test(src)) return false;
  const usesPicker =
    src.includes("defaultCeremonyInterval") ||
    src.includes("ceremonySelectableIntervals") ||
    src.includes("isProgramIncrement") ||
    src.includes("PROGRAM_INCREMENT") ||
    src.includes("intervalKind");
  return !usesPicker;
}

/** Does this source query ACTIVE intervals through Prisma without excluding PIs? */
function prismaOffender(source: string): boolean {
  const src = stripComments(source);
  if (!PRISMA_INTERVAL.test(src)) return false;
  if (!/status:\s*["']ACTIVE["']/.test(src)) return false;
  return !src.includes("PROGRAM_INCREMENT");
}

function sourceFiles(): string[] {
  return ROOTS.flatMap((r) => {
    try {
      return walk(r);
    } catch {
      return [];
    }
  });
}

describe("choosing the ACTIVE interval never picks the Program Increment", () => {
  it("no file finds an ACTIVE interval in memory without excluding PIs", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      if (ALLOWED[file]) continue;
      if (inMemoryOffender(readFileSync(file, "utf8"))) offenders.push(file);
    }

    expect(offenders, `use defaultCeremonyInterval() from @/lib/intervals/ceremony-intervals`).toEqual([]);
  });

  it("no Prisma interval query filters ACTIVE without excluding PIs", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      if (ALLOWED[file]) continue;
      if (prismaOffender(readFileSync(file, "utf8"))) offenders.push(file);
    }

    expect(
      offenders,
      `add intervalKind: { not: "PROGRAM_INCREMENT" } — a PI is ACTIVE whenever its sprints are`,
    ).toEqual([]);
  });

  it("every allowlist entry still matches, so the list cannot rot", () => {
    // A stale exemption is worse than none: it reads as "reviewed and fine"
    // for a file that may no longer contain the code that was reviewed.
    for (const [file, reason] of Object.entries(ALLOWED)) {
      const src = stripComments(readFileSync(file, "utf8"));
      const matches = IN_MEMORY.test(src) || PRISMA_INTERVAL.test(src);
      expect(matches, `${file} no longer matches — drop it from ALLOWED (${reason})`).toBe(true);
    }
  });
});

// The rules themselves, on sources written to sit either side of them. Every
// offender case has a twin that differs only in where the exclusion is
// written, so a rule that passes on a comment fails here.
describe("the rules read code, not comments", () => {
  const prismaQuery = (exclusion: string) =>
    `const s = await prisma.interval.findFirst({ where: { projectId, status: "ACTIVE", ${exclusion} } });`;
  const inMemory = (extra: string) => `${extra}\nconst active = intervals.find((i) => i.status === "ACTIVE");`;

  it("a Prisma query that excludes the PI in code passes", () => {
    expect(prismaOffender(prismaQuery(`intervalKind: { not: "PROGRAM_INCREMENT" }`))).toBe(false);
  });

  it("the same query with the exclusion only in a comment is an offender", () => {
    expect(prismaOffender(prismaQuery(`// intervalKind: { not: "PROGRAM_INCREMENT" }\n`))).toBe(true);
    expect(prismaOffender(prismaQuery(`/* PROGRAM_INCREMENT */`))).toBe(true);
  });

  it("an in-memory find that narrows kinds in code passes", () => {
    expect(inMemoryOffender(inMemory(`const sprints = all.filter((c) => !isProgramIncrement(c.intervalKind));`))).toBe(false);
  });

  it("the same find with the narrowing only in a comment is an offender", () => {
    expect(inMemoryOffender(inMemory(`// skips isProgramIncrement via defaultCeremonyInterval`))).toBe(true);
    expect(inMemoryOffender(inMemory(`/** intervalKind is checked upstream */`))).toBe(true);
  });

  it("a URL in a string is code, not a comment", () => {
    expect(stripComments(`const u = "https://x.test/PROGRAM_INCREMENT";`)).toContain("PROGRAM_INCREMENT");
  });
});
