import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every query over time entries must exclude voided rows.
 *
 * 2.251.0 turned deletion into a void — the row survives with `voidedAt` set —
 * and updated the two READ routes. About twenty other queries were missed, and
 * the gap was not cosmetic: it reopened a path that silently undoes a void.
 *
 *   void a DRAFT entry  ->  POST .../submit (looked up by id+orgId only, still
 *   DRAFT, so it becomes SUBMITTED)  ->  bulk-approve (since retired)  ->
 *   lib/pm/burn.ts counts
 *   `status: APPROVED` toward the CLIN's consumed funded value.
 *
 * A deleted entry's hours billed against a contract. Prisma has no global model
 * filter, so this depends on every call site remembering — precisely the kind of
 * rule that decays as files are added. So the rule is asserted here rather than
 * trusted at ~20 call sites: a query added tomorrow fails this test instead of
 * shipping.
 */
const ROOTS = ["src/app/api", "src/lib"];

/** `prisma.timeEntry.findMany(` / `tx.timeEntry.updateMany(` etc., across lines. */
const QUERIES = /(?:prisma|tx)\s*\.\s*timeEntry\s*\.\s*(findMany|findFirst|findUnique|count|aggregate|groupBy|updateMany)\s*\(/;

/**
 * Files that legitimately read voided entries, each with its reason. An entry
 * on this list is a decision, not an oversight.
 */
const EXEMPT: Record<string, string> = {
  "src/app/api/v1/orgs/[orgId]/time-entries/[entryId]/revisions/route.ts":
    "The audit trail must remain readable for a VOIDED entry — the void is the " +
    "most important event in it. Hiding it would defeat the purpose.",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts") && !entry.name.includes(".test."))
      out.push(full);
  }
  return out;
}

describe("time-entry queries exclude voided rows", () => {
  const files = ROOTS.flatMap(walk).filter((f) => QUERIES.test(readFileSync(f, "utf8")));

  it("found the real query sites", () => {
    // A refactor that moves these must fail loudly rather than scan nothing.
    expect(files.length).toBeGreaterThan(8);
    expect(files.some((f) => f.includes("pm/burn"))).toBe(true);
    expect(files.some((f) => f.includes("payroll/service"))).toBe(true);
  });

  it("every querying file filters voided entries, or is explicitly exempt", () => {
    const offenders = files.filter((f) => {
      if (f in EXEMPT) return false;
      const src = readFileSync(f, "utf8");
      return !src.includes("NOT_VOIDED") && !src.includes("voidedAt");
    });

    expect(offenders).toEqual([]);
  });

  it("the exemption list only names files that still exist", () => {
    // A stale exemption silently re-permits the bug under a recycled path.
    const missing = Object.keys(EXEMPT).filter((f) => !files.includes(f));
    expect(missing).toEqual([]);
  });
});
