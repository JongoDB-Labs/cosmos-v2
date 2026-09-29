// Time-entry queries agree on what "recorded" means.
//
// Three answers were live at once and two of them met on one screen. The
// finance summary counted APPROVED only and reported "Billable Hours 0.0h"
// directly above its own project table valuing that same work at $1,039,168,
// because the org's ledger is entirely SUBMITTED. Its AI twin carried no status
// filter at all and counted private drafts. The practice layer counted
// SUBMITTED-or-APPROVED in ten places and was the de facto convention nobody
// had written down.
//
// Each was self-consistent. That is what made the product look broken rather
// than wrong: no single query was a bug, and the pair could not both be right.
//
// This is the NOT_VOIDED problem again — a rule every call site has to remember
// and no schema can enforce — so it gets the same treatment: a named constant
// and a test that fails when a new query invents its own answer.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src/app/api", "src/lib"];

/** A timeEntry read, across lines. */
const QUERIES =
  /(?:prisma|tx)\s*\.\s*timeEntry\s*\.\s*(findMany|findFirst|count|aggregate|groupBy)\s*\(/;

/** A hand-written status filter, i.e. an answer given locally. */
const OWN_ANSWER = /status:\s*(?:"(?:DRAFT|SUBMITTED|APPROVED|REJECTED)"|\{\s*in:\s*\[)/;

/**
 * Queries that mean something narrower than "recorded", each with its reason.
 * An entry here is a decision, not an oversight.
 */
const EXEMPT: Record<string, string> = {
  "src/lib/payroll/service.ts":
    "A pay run may only pay for time a reviewer signed off. APPROVED-only is " +
    "the point of it, not a drift from the default.",
  "src/lib/pm/burn.ts":
    "CLIN burn is consumed FUNDED value against a contract ceiling. Reporting " +
    "unapproved hours as drawn-down government funding would be wrong in the " +
    "other direction, so this one is deliberately stricter.",
  "src/lib/pm/template-export.ts":
    "The same CLIN burn as pm/burn.ts, written into the deliverable " +
    "spreadsheet. It has to agree with the figure the dashboard shows.",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    // The composed plugin tree is not core's to police; it has its own suite.
    if (p.includes("src/plugins")) continue;
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

describe("time-entry queries share one definition of recorded time", () => {
  const files = ROOTS.filter((r) => {
    try { return statSync(r).isDirectory(); } catch { return false; }
  })
    .flatMap(walk)
    .filter((f) => QUERIES.test(readFileSync(f, "utf8")));

  it("found the real query sites", () => {
    // A refactor that moves these must fail loudly rather than scan nothing.
    expect(files.length).toBeGreaterThan(3);
    expect(files.some((f) => f.includes("finance/summary"))).toBe(true);
  });

  it("no file invents its own status filter", () => {
    const offenders = files.filter((f) => {
      if (f in EXEMPT) return false;
      const src = readFileSync(f, "utf8");
      if (!OWN_ANSWER.test(src)) return false;
      return !src.includes("RECORDED_TIME");
    });
    expect(offenders).toEqual([]);
  });

  it("the two that disagreed now use the constant", () => {
    for (const f of [
      "src/app/api/v1/orgs/[orgId]/finance/summary/route.ts",
      "src/lib/ai/executors/finance.ts",
    ]) {
      expect(readFileSync(f, "utf8")).toContain("RECORDED_TIME");
    }
  });

  it("the exemption list only names files that still query time entries", () => {
    // A stale exemption silently re-permits the drift under a recycled path.
    expect(Object.keys(EXEMPT).filter((f) => !files.includes(f))).toEqual([]);
  });
});
