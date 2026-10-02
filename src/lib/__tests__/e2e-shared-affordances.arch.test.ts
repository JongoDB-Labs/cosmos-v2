// src/lib/__tests__/e2e-shared-affordances.arch.test.ts
//
// AGENTS.md, "Before you push: check e2e/": a Playwright spec locates elements
// by accessible NAME — button text, labels, placeholders. Those are strings
// `tsc` cannot check, so a helper copied into a second spec is a silent trap:
// renaming one label fixes the copy you grepped and leaves the other spec
// failing 15 minutes later in CI. Shared e2e affordances belong in
// `e2e/fixtures/`, in ONE copy.
//
// This guard scans the specs for helpers that already live in `e2e/fixtures/`.
// It runs under vitest, which never loads `e2e/` itself — reading the files is
// the only way to assert anything about them.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const E2E = join(process.cwd(), "e2e");
const FIXTURES = join(E2E, "fixtures");

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

/** `function foo(`, `const foo = `, `let foo = ` — a DECLARATION, not a use. */
function declares(src: string, name: string): boolean {
  return new RegExp(
    `(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=)`,
  ).test(src);
}

const specs = walk(E2E).filter((f) => !f.startsWith(FIXTURES + "/"));

/** Helper name -> the fixture module that owns the single copy. */
const SHARED: Array<{ name: string; module: string }> = [
  { name: "signIn", module: "e2e/fixtures/auth.ts" },
  { name: "gotoStable", module: "e2e/fixtures/navigation.ts" },
  { name: "planSprint", module: "e2e/fixtures/intervals.ts" },
  { name: "mondayOf", module: "e2e/fixtures/weeks.ts" },
  { name: "isoDate", module: "e2e/fixtures/weeks.ts" },
];

describe("shared e2e affordances live in e2e/fixtures/", () => {
  it("finds specs to scan", () => {
    // Without this the absence-assertions below would pass on an empty list.
    expect(specs.length).toBeGreaterThan(20);
  });

  for (const { name, module } of SHARED) {
    it(`the single \`${name}\` is exported from ${module}`, () => {
      expect(readFileSync(join(process.cwd(), module), "utf8")).toMatch(
        new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`),
      );
    });

    it(`no spec re-declares \`${name}\``, () => {
      const offenders = specs
        .filter((f) => declares(readFileSync(f, "utf8"), name))
        .map((f) => f.slice(process.cwd().length + 1));
      expect(
        offenders,
        `These declare their own \`${name}\` — import it from ${module} instead:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }
});
