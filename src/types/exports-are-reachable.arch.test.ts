// Every type exported from `src/types` must be reachable from real code.
//
// `src/types/models.ts` is a plain module, so its siblings are NOT ambient —
// a declaration nobody imports is not "available", it is unreachable. The tree
// had accumulated ~250 lines of exactly that: a whole `src/types/index.ts`
// (SessionUser, OrgSummary, ApiError) that no file imported under either
// `@/types` or `@/types/index`, plus nine dead declarations in models.ts
// including entire "Phase 6"/"Phase 7" blocks.
//
// The cost is not the bytes. A dead type reads as the shared shape for a
// concept and then drifts from the live one, so the next author models an API
// on a lie: `ClassificationLevel`/`ComplianceFramework` here had already
// diverged from the @prisma/client enums the classification and compliance code
// actually uses, and `BoardTemplate` had been re-declared locally twice because
// nobody found the version sitting in models.ts. A type that ships with no call
// site is a second mechanism with a delay on it.
//
// So the rule is reachability, not tidiness: a name here either has an importer
// or supports one that does.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TYPES_DIR = "src/types";
const SCAN_ROOTS = ["src", "e2e", "prisma", "scripts"];

/** Strip comments so prose naming a type or a module path is not read as code. */
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

/** The module specifiers that resolve to a given file under `src/types`. */
function specifiersFor(file: string): string[] {
  const base = file.replace(/\.tsx?$/, "");
  return base === "index" ? ["@/types", "@/types/index"] : [`@/types/${base}`];
}

const typeFiles = readdirSync(TYPES_DIR).filter(
  (f) => /\.ts$/.test(f) && !/\.d\.ts$/.test(f) && !/\.test\.ts$/.test(f),
);

const consumers = SCAN_ROOTS.flatMap(walk).filter((f) => !f.startsWith(`${TYPES_DIR}/`));

/** Names imported from `spec` anywhere in the repo, and how many sites name it. */
function importsOf(spec: string): { names: Set<string>; mentions: number; statements: number } {
  const names = new Set<string>();
  let mentions = 0;
  let statements = 0;
  const braced = new RegExp(
    `(?:import|export)\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${spec}["']`,
    "g",
  );
  const anyMention = new RegExp(`["']${spec}["']`, "g");
  for (const f of consumers) {
    const src = code(readFileSync(f, "utf8"));
    mentions += src.match(anyMention)?.length ?? 0;
    for (const m of src.matchAll(braced)) {
      statements++;
      for (const raw of m[1].split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
        if (name) names.add(name);
      }
    }
  }
  return { names, mentions, statements };
}

describe("src/types exports are reachable", () => {
  it("scanned a real tree", () => {
    expect(typeFiles).toContain("models.ts");
    expect(consumers.length).toBeGreaterThan(200);
    // The scan only sees named imports; if a file reached models.ts some other
    // way (default import, `import("@/types/models").X`) the counts below would
    // under-report and the reachability check would go quietly vacuous.
    const models = importsOf("@/types/models");
    expect(models.statements).toBe(models.mentions);
    expect(models.names.has("WorkItem")).toBe(true);
  });

  it("no exported type is unreachable", () => {
    const orphans: string[] = [];
    for (const file of typeFiles) {
      const src = code(readFileSync(join(TYPES_DIR, file), "utf8"));
      const imported = new Set(specifiersFor(file).flatMap((s) => [...importsOf(s).names]));
      for (const m of src.matchAll(
        /^export\s+(?:interface|type|enum|const|function|class)\s+(\w+)/gm,
      )) {
        const name = m[1];
        if (imported.has(name)) continue;
        // Supporting a type that IS imported counts as reachable — the
        // declaration itself is the first occurrence, so >1 means referenced.
        const uses = src.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
        if (uses < 2) orphans.push(`${TYPES_DIR}/${file}: ${name}`);
      }
    }
    expect(orphans).toEqual([]);
  });
});
