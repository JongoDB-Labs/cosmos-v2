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
      const src = readFileSync(file, "utf8");
      if (!IN_MEMORY.test(src)) continue;

      // Permitted when the file goes through the shared picker, or filters the
      // container out itself.
      // `intervalKind` counts as narrowing, so a file that filters kinds itself
      // is not an offender. NOTE that an allowlist (`kind === "SPRINT"`) is
      // weaker than excluding the container — sprint-board.tsx does this and
      // falls back to ALL intervals when a project runs no SPRINTs, which puts
      // the PI back in the pool. Milder than the bug this guards, but real.
      const usesPicker =
        src.includes("defaultCeremonyInterval") ||
        src.includes("ceremonySelectableIntervals") ||
        src.includes("isProgramIncrement") ||
        src.includes("PROGRAM_INCREMENT") ||
        src.includes("intervalKind");
      if (!usesPicker) offenders.push(file);
    }

    expect(offenders, `use defaultCeremonyInterval() from @/lib/intervals/ceremony-intervals`).toEqual([]);
  });

  it("no Prisma interval query filters ACTIVE without excluding PIs", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      if (ALLOWED[file]) continue;
      const src = readFileSync(file, "utf8");
      if (!PRISMA_INTERVAL.test(src)) continue;
      if (!/status:\s*["']ACTIVE["']/.test(src)) continue;
      if (!src.includes("PROGRAM_INCREMENT")) offenders.push(file);
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
      const src = readFileSync(file, "utf8");
      const matches = IN_MEMORY.test(src) || PRISMA_INTERVAL.test(src);
      expect(matches, `${file} no longer matches — drop it from ALLOWED (${reason})`).toBe(true);
    }
  });
});
