// No "use client" module may reach the database client, however many hops away.
//
// `next build` is the ONLY gate that sees this. A client component that imports
// a server module pulls the Prisma pg driver into the browser bundle, and the
// build dies on `Module not found: Can't resolve 'util/types'` from inside
// node_modules/pg. vitest and `tsc --noEmit` both pass in that state, because
// neither walks a bundle graph -- 9245 green tests and a clean type-check said
// nothing while 2.512.0 was unbuildable.
//
// It happened because `recent.ts` held both a Prisma query AND the pure window
// vocabulary the client picker needed, so one honest-looking named import
// dragged the driver across the boundary. The fix was to split the pure half
// into `recent-windows.ts`; this test is the part that stops the next one.
//
// Written as a graph walk, not a list of known-bad pairs: the defect is a PATH,
// and a rule that only knew about today's two files would be a guard narrower
// than its name.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SRC = "src";
/** Reaching any of these from the browser bundles a database driver. */
const DB_MODULES = new Set(
  ["src/lib/db/client.ts", "src/lib/db/client.tsx"].map((p) => resolve(p)),
);
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name))
      out.push(full);
  }
  return out;
}

/** Blank comments rather than dropping them, so a commented-out import is ignored. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * Every module specifier `file` has a RUNTIME edge to.
 *
 * Type-only imports are excluded, and that distinction is the whole game: the
 * first draft of this test counted them and reported 63 files, because real
 * server chains are routinely stitched together with `import type` -- e.g.
 * `lib/workflow/actions.ts` takes only a `WorkItemPatch` type from
 * `apply-change.server`. Those are erased before bundling, so a guard that
 * followed them would be wider than its name and would block correct code.
 *
 * Anchored by walking BACK from each `from "..."` to the statement keyword,
 * rather than forward with a lazy `[\s\S]*?`: a forward match starting at an
 * `export function` with no `from` of its own ran on to the NEXT statement's
 * specifier, mis-attributing that edge and consuming it so it was never seen
 * again. A dropped edge is the failure mode that matters here -- it reads as a
 * pass.
 */
function importsOf(file: string): string[] {
  const text = code(readFileSync(file, "utf8"));
  const out: string[] = [];

  for (const m of text.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
    const head = text.slice(0, m.index);
    const kw = head.search(/(?:^|\n)[ \t]*(?:import|export)\b(?![\s\S]*(?:^|\n)[ \t]*(?:import|export)\b)/);
    if (kw === -1) continue;
    if (!isTypeOnly(text.slice(kw, m.index!))) out.push(m[1]);
  }

  // Side-effect imports (`import "./x"`) and dynamic imports are real edges.
  for (const m of text.matchAll(/\bimport\s*(?:\(\s*)?["']([^"']+)["']/g)) out.push(m[1]);

  return out;
}

/** True when nothing in the statement survives to runtime. */
function isTypeOnly(stmt: string): boolean {
  if (/^\s*(?:import|export)\s+type\b/.test(stmt)) return true;

  const braces = stmt.match(/\{([\s\S]*)\}/);
  if (!braces) return false;

  // A default or namespace binding outside the braces is a value edge.
  const beforeBrace = stmt.slice(0, stmt.indexOf("{")).replace(/^\s*(?:import|export)\s*/, "");
  if (/[A-Za-z_$*]/.test(beforeBrace)) return false;

  const specifiers = braces[1]
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return specifiers.length > 0 && specifiers.every((x) => /^type\s/.test(x));
}

/** A directory also "exists", and reading one throws EISDIR. */
function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** `@/x` -> src/x, `./x` -> sibling. Anything else is a package: not our graph. */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = join(dirname(fromFile), spec);
  else return null;

  for (const ext of ["", ...EXTENSIONS]) {
    const candidate = base + ext;
    if (isFile(candidate)) return resolve(candidate);
  }
  for (const ext of EXTENSIONS) {
    const candidate = join(base, "index" + ext);
    if (isFile(candidate)) return resolve(candidate);
  }
  return null;
}

const isClient = (file: string) =>
  /^\s*["']use client["']/m.test(readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""));

/**
 * The shortest import path from `entry` to a database module, or null.
 *
 * Returns the path rather than a boolean so a failure names every hop -- a gate
 * that fails without saying what it saw costs more than it saves.
 */
function pathToDb(entry: string, edges: (f: string) => string[]): string[] | null {
  const queue: string[][] = [[resolve(entry)]];
  const seen = new Set([resolve(entry)]);
  while (queue.length) {
    const path = queue.shift()!;
    const head = path[path.length - 1];
    if (DB_MODULES.has(head)) return path;
    for (const next of edges(head)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}

const rel = (p: string) => p.replace(resolve(".") + "/", "");

describe("the client bundle never reaches the database", () => {
  const files = walk(SRC);
  const graph = new Map<string, string[]>();
  const edgesOf = (file: string): string[] => {
    const cached = graph.get(file);
    if (cached) return cached;
    const out = isFile(file)
      ? importsOf(file)
          .map((s) => resolveSpecifier(s, file))
          .filter((p): p is string => p !== null)
      : [];
    graph.set(file, out);
    return out;
  };

  const clientFiles = files.filter(isClient);

  it("finds client components to check", () => {
    // Positive control for the discovery half: a silent zero would make every
    // assertion below vacuous.
    expect(clientFiles.length).toBeGreaterThan(50);
  });

  it("finds the database module it is guarding", () => {
    expect([...DB_MODULES].some((p) => existsSync(p))).toBe(true);
  });

  it("no \"use client\" module imports a path that ends at the db client", () => {
    const offenders = clientFiles
      .map((f) => ({ file: f, path: pathToDb(f, edgesOf) }))
      .filter((o) => o.path !== null)
      .map((o) => `${rel(o.file)}\n      ${o.path!.map(rel).join("\n   -> ")}`);

    expect(offenders).toEqual([]);
  });

  it("detects the 2.512.0 defect when it is replayed", () => {
    // The control that matters: prove the walk CAN see a transitive hit, by
    // running it over the exact shape that shipped broken -- a client file
    // importing a module that imports the db client. Without this, a resolver
    // that silently returned null for every specifier would read as a pass.
    const victim = resolve("src/components/projects/recent-window-picker.tsx");
    const serverModule = resolve("src/lib/projects/recent.ts");
    expect(existsSync(victim) && existsSync(serverModule)).toBe(true);
    expect(isClient(victim)).toBe(true);

    const replayed = (file: string): string[] =>
      file === victim ? [serverModule, ...edgesOf(file)] : edgesOf(file);

    const found = pathToDb(victim, replayed);
    expect(found).not.toBeNull();
    expect(found!.map(rel)).toEqual([
      "src/components/projects/recent-window-picker.tsx",
      "src/lib/projects/recent.ts",
      "src/lib/db/client.ts",
    ]);
  });
});
