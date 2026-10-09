// Every export from `src/lib/time` must be reachable from real code.
//
// Same rule, same machinery as `src/lib/pm/exports-are-reachable.arch.test.ts`
// (itself `src/types/exports-are-reachable.arch.test.ts` pointed at a library),
// applied to the time library because CLEANUP-16 found the same two shapes here
// that CLEANUP-15 found there:
//
//   • a value exported "in case someone needs it" that no file imports
//     (`EDITABLE_STATUSES`, `excludeVoided`) — and in `excludeVoided`'s case the
//     doc block had grown a confident, wrong claim about an arch test keying on
//     it, because nothing ever exercised the path;
//   • a helper whose only importer is its own test (`samePeriod`,
//     `billedHoursOf`/`billingVariance`/`isWrittenDown`), which reads as a
//     shared rule while the real call site re-derives it inline — exactly the
//     duplication the module header claimed to prevent.
//
// Reachability, not tidiness: a name here either has an importer, or it
// supports one that does. A type used only to annotate the module's own
// internals is fine — it just shouldn't be `export`ed. A test is NOT an
// importer: `__tests__` and `*.test.ts` are excluded from the consumer scan, so
// a helper kept alive solely by its own spec still counts as unreachable.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TIME_DIR = "src/lib/time";
const SCAN_ROOTS = ["src", "e2e", "prisma", "scripts"];

/** Strip comments so prose naming an export or a module path isn't read as code. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

const isTest = (name: string) => /\.test\.tsx?$/.test(name) || name === "__tests__";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || isTest(entry.name)) continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx|mts)$/.test(entry.name) && !isTest(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const moduleFiles = readdirSync(TIME_DIR).filter(
  (f) => /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f) && !isTest(f),
);

// Read every candidate consumer once; each module then scans the cache.
// Siblings DO count as consumers (period.ts imports `./date-only`), so only the
// module under test is excluded.
const sources = new Map(
  SCAN_ROOTS.flatMap(walk).map((f) => [f, code(readFileSync(f, "utf8"))]),
);

/**
 * Module specifiers that resolve to `<TIME_DIR>/<base>`: the `@/lib/time/x`
 * alias, the deep relative form scripts use (`../../src/lib/time/x`), and `./x`
 * from a sibling.
 */
function specifierPattern(base: string): string {
  return `["'](?:[^"']*\\/time\\/|\\.\\/)${base}["']`;
}

interface Usage {
  /** Names other files pull out of this module. */
  names: Set<string>;
  /** Every mention of the module's specifier, however it is written. */
  mentions: number;
  /** Mentions in a form this scan understands (static, dynamic, or vi.mock). */
  accounted: number;
}

function usageOf(base: string, self: string): Usage {
  const spec = specifierPattern(base);
  const staticImport = new RegExp(
    `(?:import|export)\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*${spec}`,
    "g",
  );
  const dynamicImport = new RegExp(
    `\\{([^}]*)\\}\\s*=\\s*await\\s+import\\(\\s*${spec}\\s*\\)`,
    "g",
  );
  const mocked = new RegExp(`vi\\.mock\\(\\s*${spec}`, "g");
  const anyMention = new RegExp(spec, "g");

  const names = new Set<string>();
  let mentions = 0;
  let accounted = 0;
  for (const [file, src] of sources) {
    if (file === self) continue;
    mentions += src.match(anyMention)?.length ?? 0;
    accounted += src.match(mocked)?.length ?? 0;
    for (const re of [staticImport, dynamicImport]) {
      for (const m of src.matchAll(re)) {
        accounted++;
        for (const raw of m[1].split(",")) {
          const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
          if (name) names.add(name);
        }
      }
    }
  }
  return { names, mentions, accounted };
}

const DECLARATION =
  /^export\s+(?:async\s+)?(interface|type|enum|const|let|function|class)\s+(\w+)/gm;

const VALUE_KINDS = new Set(["const", "let", "function", "class"]);

/**
 * Exported values in `src/lib/time` that still have no importer. Every one
 * lives in a module outside CLEANUP-16's scope, so they are RECORDED rather
 * than fixed — prune an entry when its module is cleaned, don't add one.
 *
 * `routeFor` is the one that is arguably fine as it stands: it is the pure core
 * of `resolveApprovalRoute` in its own file and is exported so a test can reach
 * it without a database. The others are the same shape this sweep deleted.
 */
const KNOWN_UNIMPORTED = [
  "revisions.ts: diffSnapshots",
  "revisions.ts: snapshotEntry",
  "routing.ts: routeFor",
  "submit-gate.ts: submitGate",
  "time-off.ts: RESERVES_CAPACITY",
  "time-off.ts: hoursInWindow",
  "time-off.ts: isWeekend",
  "time-off.ts: workingDaysBetween",
];

interface Decl {
  file: string;
  kind: string;
  name: string;
  /** Occurrences of the name inside its own module (1 = the declaration only). */
  selfUses: number;
  imported: boolean;
}

const declarations: Decl[] = [];
const unbalanced: string[] = [];

for (const file of moduleFiles) {
  const self = join(TIME_DIR, file);
  const src = code(readFileSync(self, "utf8"));
  const { names, mentions, accounted } = usageOf(file.replace(/\.tsx?$/, ""), self);
  // If a consumer reached this module some way the scan doesn't model, `names`
  // would under-report and every check below would go quietly vacuous.
  if (mentions !== accounted) unbalanced.push(`${file}: ${mentions} mentions, ${accounted} parsed`);
  for (const m of src.matchAll(DECLARATION)) {
    const [, kind, name] = m;
    declarations.push({
      file,
      kind,
      name,
      selfUses: src.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0,
      imported: names.has(name),
    });
  }
}

describe("src/lib/time exports are reachable", () => {
  it("scanned a real tree", () => {
    expect(moduleFiles).toContain("routing.ts");
    expect(moduleFiles).toContain("period.ts");
    expect(sources.size).toBeGreaterThan(200);
    expect(declarations.length).toBeGreaterThan(20);
    expect(unbalanced).toEqual([]);
    // The specifier pattern really does find importers, so "no importer" below
    // means absent rather than unmatched.
    expect(declarations.filter((d) => d.imported).length).toBeGreaterThan(10);
  });

  it("the consumer scan ignores tests", () => {
    // The whole point of the rule: a helper whose only importer is its own spec
    // is still dead. If a *.test.ts ever leaks into `sources`, every orphan
    // below quietly resurrects.
    expect([...sources.keys()].filter((f) => /\.test\.tsx?$/.test(f))).toEqual([]);
    expect([...sources.keys()].filter((f) => f.includes("__tests__"))).toEqual([]);
  });

  it("no exported declaration is unreachable", () => {
    // Stricter than the check below: no importer AND no use inside its own
    // module, so the declaration is the only occurrence in the tree.
    const orphans = declarations
      .filter((d) => !d.imported && d.selfUses < 2)
      .map((d) => `${d.file}: ${d.name}`)
      .filter((k) => !KNOWN_UNIMPORTED.includes(k));
    expect(orphans).toEqual([]);
  });

  it("no exported value lacks an importer", () => {
    const unimported = declarations
      .filter((d) => !d.imported && VALUE_KINDS.has(d.kind))
      .map((d) => `${d.file}: ${d.name}`);
    expect(unimported.sort()).toEqual([...KNOWN_UNIMPORTED].sort());
  });
});
