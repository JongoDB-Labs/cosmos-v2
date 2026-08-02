// @vitest-environment node
//
// Whoever reads `timeEntry` obeys the time read rule — routes AND AI tools.
//
// TIME_READ is held by MEMBER and VIEWER, so it says the actor may read SOME
// time, never WHOSE. The scope is a second question, answered by
// `readableTimeUserIds`, and rates are a third, answered by `redactRates`
// (own row, or FINANCE_READ).
//
// `GET /time-entries` was fixed in 2.249.22. The AI tool reading the same table
// through a different door was not, and kept returning the whole org's hours
// and rates to anyone who could open the chat. That is the third time in this
// codebase a shared rule was fixed in the consumer that happened to be open and
// missed elsewhere — `voidedAt` and `laborCostFor` were the other two.
//
// So this asserts the RULE across every consumer. A grep-based arch test is
// crude, but it is the only kind that fails for a NEW reader nobody thought to
// test, which is exactly how this survived.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Source with comments stripped, so the rule never fires on prose about it. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Files that list time entries UNDER TIME_READ — the dangerous combination, and
 * the only one this rule can sensibly police.
 *
 * The scope helper is not required of every reader, and demanding it of all of
 * them was this test's first, wrong shape: it flagged six consumers that are
 * all correctly gated. `finance/summary`, `ai/executors/finance` and
 * `payroll/service` require FINANCE_READ; `pm/burn` and `pm/template-export`
 * emit only aggregates, with per-person rates used internally and discarded;
 * `export/csv` requires ORG_EXPORT, which is ADMIN-and-above and comes with
 * FINANCE_READ already.
 *
 * What makes a reader dangerous is reaching per-person rows while gating on
 * TIME_READ — a permission MEMBER and VIEWER both hold, so it authorises
 * reading SOME time and says nothing about WHOSE.
 */
const readers = walk(SRC).filter((f) => {
  const src = code(f);
  return (
    /prisma\.timeEntry\.findMany/.test(src) &&
    /Permission\.TIME_READ\b/.test(src)
  );
});

describe("every TIME_READ-gated reader of time entries obeys the scope rule", () => {
  it("finds the readers at all", () => {
    // Guards the guard: if the query shape changes and this matches nothing,
    // every assertion below would pass vacuously while the rule went
    // unenforced — the failure mode this whole file exists to prevent.
    expect(readers.length).toBeGreaterThan(0);
  });

  it("narrows through readableTimeUserIds", () => {
    const offenders = readers.filter(
      (f) => !/readableTimeUserIds/.test(code(f)),
    );

    expect(
      offenders.map((f) => f.replace(SRC, "src")),
      "listing time entries without the scope helper returns the whole org",
    ).toEqual([]);
  });

  it("strips rates it may not show", () => {
    // A supervisor may confirm somebody's HOURS without seeing their PAY.
    const offenders = readers.filter(
      (f) => !/redactRates|canSeeRate/.test(code(f)),
    );

    expect(
      offenders.map((f) => f.replace(SRC, "src")),
      "listing time entries without redacting rates exposes pay",
    ).toEqual([]);
  });

  it("covers the AI tool, not just the HTTP routes", () => {
    // Names the specific gap this test was written for, so that deleting the
    // AI reader from the rule is a visible change rather than a quiet one.
    expect(
      readers.some((f) => f.includes(join("lib", "ai"))),
      "the AI time tool should be among the readers this rule covers",
    ).toBe(true);
  });
});
