// @vitest-environment node
//
// Cost rate is FINANCE_READ data, everywhere, including on the way out.
//
// `GET /projects/:id/staffing` has always withheld `costRate` from callers
// without FINANCE_READ. The two workbook exporters read the same data through
// the same helper and passed `includeCost: true` outright — so the field the
// API refused to show was written into a spreadsheet for anyone who could read
// the project. That is the recurring shape in this codebase: a shared rule
// enforced in the consumer that happened to be open, and missed in the others.
//
// So this asserts the RULE rather than the call sites. A grep-based arch test
// is crude, but it is the only kind that fails for a NEW caller nobody thought
// to test — which is precisely how this got in.
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

const files = walk(SRC);

/**
 * Source with comments removed.
 *
 * Without this the rule fires on prose — including the comments that EXPLAIN
 * the rule, which is how it first failed. An arch test that flags documentation
 * teaches people to phrase around it, and a rule people route around enforces
 * nothing.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("cost rate never rides on a weaker permission than FINANCE_READ", () => {
  it("no caller hardcodes includeCost: true", () => {
    // The literal is the bug. A caller must pass either `false` (it does not
    // write the field) or a value derived from the actor's permissions — both
    // of which require having thought about it.
    const offenders = files.filter((f) => /includeCost:\s*true/.test(code(f)));

    expect(
      offenders.map((f) => f.replace(SRC, "src")),
      "pass includeCost from the caller's FINANCE_READ, not a literal true",
    ).toEqual([]);
  });

  it("every route that builds a project workbook consults FINANCE_READ", () => {
    // buildProjectWorkbook writes a "Cost Rate" column. Any route reaching it
    // has to decide whether this caller may see that, and the only correct
    // source for the answer is their permissions.
    const callers = files.filter(
      (f) => f.includes(join("src", "app")) && /buildProjectWorkbook\s*\(/.test(code(f)),
    );
    // Guards the guard: if the function is renamed and this finds nothing, the
    // test would pass vacuously while the rule went unenforced.
    expect(callers.length).toBeGreaterThan(0);

    for (const f of callers) {
      expect(
        code(f),
        `${f.replace(SRC, "src")} builds a workbook without checking FINANCE_READ`,
      ).toMatch(/FINANCE_READ/);
    }
  });

  it("the staffing route still gates the field it introduced", () => {
    // The original enforcement, pinned. If this one regresses, the exports
    // above are consistent with something that is itself wrong.
    const route = join(
      SRC,
      "app/api/v1/orgs/[orgId]/projects/[projectId]/staffing/route.ts",
    );
    expect(code(route)).toMatch(
      /includeCost[\s\S]{0,120}FINANCE_READ|FINANCE_READ[\s\S]{0,120}includeCost/,
    );
  });
});
