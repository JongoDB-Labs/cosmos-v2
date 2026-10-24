// `prisma/seed/**` has no runtime in CI — the demo seeds are run by hand against a
// deployed database — so nothing here is covered by a behavioural test and the files
// drift quietly. The nightly sweep (CLEANUP-23) found nine such drifts at once: three
// comments describing writes the code does not make, a copy of the RBAC bit table, the
// same `.env.local` parser pasted into eight scripts, a dead binding, a field set on
// nine literals and read by nothing, a permission mask written raw past the DB
// boundary, and a no-op kept alive by one call.
//
// Each of those is checkable from the source text, which IS the artifact for a script
// nobody executes in CI. Source-level, following the existing *.arch.test.ts pattern
// (src/lib/__tests__/carryover-plan-hygiene.arch.test.ts,
// src/types/exports-are-reachable.arch.test.ts).
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SEED_DIR = "prisma/seed";

function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return walk(rel);
    return /\.ts$/.test(e.name) ? [rel] : [];
  });
}

const seedFiles = walk(SEED_DIR).map((path) => ({
  path,
  text: readFileSync(join(ROOT, path), "utf8"),
}));

const read = (path: string): string => {
  const hit = seedFiles.find((f) => f.path === path);
  if (!hit) throw new Error(`${path} is gone — this test's anchor moved`);
  return hit.text;
};

/** Seed files whose text matches, as repo-relative paths. */
function offenders(re: RegExp, except: string[] = []): string[] {
  return seedFiles
    .filter((f) => !except.includes(f.path) && re.test(f.text))
    .map((f) => f.path)
    .sort();
}

/** Just the prose of `//` and `*` comment lines — the stale half of a drifted file. */
function commentLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.match(/^\s*(?:\/\/|\*)\s?(.*)$/)?.[1])
    .filter((l): l is string => l != null);
}

/** Field names declared on a `model X { … }` block in schema.prisma. */
function modelFields(model: string): string[] {
  const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
  const block = schema.match(new RegExp(`^model ${model} \\{\\n([\\s\\S]*?)^\\}`, "m"));
  if (!block) throw new Error(`model ${model} not found in schema.prisma`);
  return [...block[1].matchAll(/^\s{2}(\w+)\s+\S/gm)].map((m) => m[1]);
}

it("finds the seed scripts at all", () => {
  // Guards every assertion below: if prisma/seed moves, they all start passing
  // vacuously and this one says so.
  expect(seedFiles.length).toBeGreaterThan(10);
  expect(seedFiles.map((f) => f.path)).toContain(`${SEED_DIR}/demo-defense.ts`);
});

describe("one .env.local loader, not eight copies", () => {
  const SHARED = `${SEED_DIR}/shared/env-local.ts`;

  it("exports the loader and its preferProcessEnv variant", () => {
    const text = read(SHARED);
    expect(text).toMatch(/export function loadEnvLocal\(/);
    expect(text).toMatch(/export function resolveDbUrl\(/);
  });

  it("no script hand-rolls the parser", () => {
    // The copies differed only in whether they returned the parsed DATABASE_URL or
    // process.env's, so a fix to the parsing (quoted values, key charset) landed in
    // one of eight and the other seven kept the old behaviour.
    expect(offenders(/readFileSync\([\s\S]{0,40}"\/\.env\.local"/, [SHARED])).toEqual([]);
  });

  it("every script that needs a DB URL imports it from shared/", () => {
    // Vacuity guard for the rule above: deleting the call sites would also empty
    // the offender list.
    expect(offenders(/from "\.\/shared\/env-local"/)).toEqual([
      `${SEED_DIR}/bootstrap-org.ts`,
      `${SEED_DIR}/demo-defense-extra.ts`,
      `${SEED_DIR}/demo-defense-fill.ts`,
      `${SEED_DIR}/demo-defense-pm.ts`,
      `${SEED_DIR}/demo-defense-teardown.ts`,
      `${SEED_DIR}/demo-defense.ts`,
      `${SEED_DIR}/roadmap-import.ts`,
      `${SEED_DIR}/wire-keycloak-idp.ts`,
    ]);
  });
});

describe("RBAC masks come from the bitfield and cross the DB boundary once", () => {
  it("no script re-declares a permission bit shift", () => {
    // demo-defense-fill.ts carried its own 17-entry `P` table whose shifts happened
    // to match src/lib/rbac/permissions.ts. Renumber a bit there and the seed would
    // keep granting the old one, silently.
    expect(offenders(/^\s*[A-Z][A-Z_0-9]+:\s*1n\s*<<\s*\d+n\s*,/m)).toEqual([]);
  });

  it("demo-defense-fill.ts grants from the real Permission bitfield", () => {
    expect(read(`${SEED_DIR}/demo-defense-fill.ts`)).toMatch(
      /import \{[\s\S]*?\bPermission as P\b[\s\S]*?\} from "\.\.\/\.\.\/src\/lib\/rbac\/permissions"/,
    );
  });

  it("no script writes a permission mask raw", () => {
    // AGENTS.md, "Server-side response patterns": masks cross the DB boundary with
    // maskFromDb()/maskToDb() and are never "written raw". Every other writer in the
    // repo (the work-roles routes) already does.
    expect(offenders(/\b(?:grants|permissions):\s*[\w.]+\.toString\(\)/)).toEqual([]);
    expect(read(`${SEED_DIR}/demo-defense-fill.ts`)).toMatch(/grants: maskToDb\(/);
  });
});

describe("seed literals do not carry fields no model can store", () => {
  it("only Risk has a branch column, so only RiskSeed carries branchCode", () => {
    // branchCode was declared on DeliverableSeed, BlockerSeed and ChangeSeed and set
    // on nine literals, but none of those three upserts passed it and none of those
    // three models has anywhere to put it.
    const withBranch = ["Risk", "Deliverable", "Blocker", "ChangeRequest"].filter((m) =>
      modelFields(m).includes("branch"),
    );
    expect(withBranch).toEqual(["Risk"]);

    const pm = read(`${SEED_DIR}/demo-defense-pm.ts`);
    const declaring = [...pm.matchAll(/type (\w+) = \{([\s\S]*?)\n\};/g)]
      .filter((m) => m[2].includes("branchCode"))
      .map((m) => m[1]);
    expect(declaring).toEqual(["RiskSeed"]);

    // …and every literal that sets it is a Risk (R-00n), not a CDRL/BL/CR row.
    const setters = pm
      .split("\n")
      .filter((l) => /\bbranchCode:/.test(l) && /\bcode: "/.test(l))
      .map((l) => l.match(/\bcode: "([A-Z]+)-/)![1]);
    expect(setters).toEqual(["R", "R", "R", "R"]);
  });

  it("every findUser binding in demo-defense-extra.ts is read", () => {
    // `tom` was bound and never used; the persona it resolves is already a
    // prerequisite created by demo-defense.ts.
    const text = read(`${SEED_DIR}/demo-defense-extra.ts`);
    const names = [...text.matchAll(/const (\w+) = await findUser\(/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(5);
    const unread = names.filter(
      (n) => text.split(new RegExp(`\\b${n}\\b`)).length - 1 < 2,
    );
    expect(unread).toEqual([]);
  });
});

describe("the legacy no-op migration is gone", () => {
  it("has no migrate-legacy module and no reference to it", () => {
    // Its own comment said the data migration completed before the models were
    // dropped; all it did was print a line saying it had nothing to do.
    expect(existsSync(join(ROOT, `${SEED_DIR}/migrate-legacy.ts`))).toBe(false);
    expect(offenders(/migrateLegacyData|\.\/migrate-legacy/)).toEqual([]);
    // Vacuity guard: index.ts still orchestrates the real seeders.
    expect(read(`${SEED_DIR}/index.ts`)).toMatch(/await seedSoftwareSector\(prisma\)/);
  });
});

describe("comments describe the writes the code actually makes", () => {
  it("does not promise milestones a baseline or projected date", () => {
    // The Milestone model has neither column — the update beneath that comment
    // writes scheduleEscalate/rootCause/recoveryPlan.
    const fields = modelFields("Milestone");
    expect(fields.some((f) => /baseline|projected/i.test(f))).toBe(false);
    const claims = commentLines(read(`${SEED_DIR}/demo-defense-pm.ts`)).filter((l) =>
      /milestones?\b[^.]*\bbaseline/i.test(l),
    );
    expect(claims).toEqual([]);
  });

  it("drift-probe's idempotency note states no row count that disagrees with SCENARIOS", () => {
    const text = read(`${SEED_DIR}/drift-probe.ts`);
    const scenarios = [...text.matchAll(/^\s*\{ n: \d+, label:/gm)].length;
    expect(scenarios).toBe(18); // guards the comparison below

    const WORDS: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, twenty: 20 };
    const stated = [...text.matchAll(/\bset of (\w+) rows\b/g)].map(
      (m) => WORDS[m[1]] ?? Number(m[1]),
    );
    expect(stated.filter((n) => n !== scenarios)).toEqual([]);
  });

  it("test-fixtures' second-board docblock names the type the code creates", () => {
    const text = read(`${SEED_DIR}/test-fixtures.ts`);
    const fn = text.match(
      /\/\*\*([\s\S]*?)\*\/\s*async function ensureSecondBoard\(([\s\S]*?)\n\}/,
    );
    expect(fn).not.toBeNull();
    const created = fn![2].match(/type: "(\w+)"/)![1];
    expect(created).toBe("KANBAN"); // guards the comparison below
    const named = [...fn![1].matchAll(/\btype \((\w+)\)/g)].map((m) => m[1]);
    expect(named.filter((t) => t !== created)).toEqual([]);
  });
});
