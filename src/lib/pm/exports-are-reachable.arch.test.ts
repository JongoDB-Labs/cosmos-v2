// Every export from `src/lib/pm` must be reachable from real code.
//
// Same rule, same reasoning as `src/types/exports-are-reachable.arch.test.ts` —
// applied to the PM library instead of the type barrel, because this is where
// the nightly sweep keeps finding the same two shapes:
//
//   • a declaration nobody imports AND nobody references inside its own module
//     (`DerivedMilestone`: an `Awaited<ReturnType<…>>` alias with exactly one
//     occurrence in the tree, its own definition);
//   • a value exported "in case someone needs it" that no file imports, so the
//     next author writes their own (`cacOk`/`trainingOk`/`accessOk`/`ndaOk` were
//     exported from staffing.ts while staffing-tracker.tsx defined private
//     copies of all four — the same rule in two places, free to drift).
//
// Reachability, not tidiness: a name here either has an importer, or it supports
// one that does. A type used only to annotate the module's own internals is
// fine — it just shouldn't be `export`ed.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PM_DIR = "src/lib/pm";
const SCAN_ROOTS = ["src", "e2e", "prisma", "scripts"];

/** Strip comments so prose naming an export or a module path isn't read as code. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx|mts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const moduleFiles = readdirSync(PM_DIR).filter(
  (f) => /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f) && !/\.test\.tsx?$/.test(f),
);

// Read every candidate consumer once; each module then scans the cache. Unlike
// the src/types scan, siblings DO count as consumers here (schedule.ts imports
// `./milestone-date`), so only the module under test is excluded.
const sources = new Map(
  SCAN_ROOTS.flatMap(walk).map((f) => [f, code(readFileSync(f, "utf8"))]),
);

/**
 * Module specifiers that resolve to `<PM_DIR>/<base>`: the `@/lib/pm/x` alias,
 * the deep relative form scripts use (`../../src/lib/pm/x`), and `./x` from a
 * sibling.
 */
function specifierPattern(base: string): string {
  return `["'](?:[^"']*\\/pm\\/|\\.\\/)${base}["']`;
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
 * Exported values in `src/lib/pm` that still have no importer. Both live in
 * modules outside this sweep's scope, so they are recorded rather than fixed —
 * prune an entry when its module is cleaned, don't add one.
 */
const KNOWN_UNIMPORTED = ["activity-log.ts: actVal", "subjects.ts: PM_SUBJECT_TYPES"];

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
  const self = join(PM_DIR, file);
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

describe("src/lib/pm exports are reachable", () => {
  it("scanned a real tree", () => {
    expect(moduleFiles).toContain("export.ts");
    expect(moduleFiles).toContain("staffing.ts");
    expect(sources.size).toBeGreaterThan(200);
    expect(declarations.length).toBeGreaterThan(20);
    expect(unbalanced).toEqual([]);
    // The specifier pattern really does find importers, so "no importer" below
    // means absent rather than unmatched.
    expect(declarations.filter((d) => d.imported).length).toBeGreaterThan(10);
  });

  it("no exported declaration is unreachable", () => {
    const orphans = declarations
      .filter((d) => !d.imported && d.selfUses < 2)
      .map((d) => `${d.file}: ${d.name}`);
    expect(orphans).toEqual([]);
  });

  it("no exported value lacks an importer", () => {
    const unimported = declarations
      .filter((d) => !d.imported && VALUE_KINDS.has(d.kind))
      .map((d) => `${d.file}: ${d.name}`);
    expect(unimported.sort()).toEqual([...KNOWN_UNIMPORTED].sort());
  });
});
